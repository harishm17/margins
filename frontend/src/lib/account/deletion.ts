/**
 * Deleting an account, step by step. Pure: the database and storage come in as `store` and
 * `files` (src/server/account.ts wires the real ones), so the order and the retry behaviour are
 * unit tested without either.
 *
 * The order matters:
 * 1. Stop the account's jobs (pending and processing become failed, not retryable), so no worker
 *    claims, retries or re-dispatches them. A worker already running loses its lease; anything it
 *    writes later is refused by the foreign keys once step 3 has run (except its spend, which is
 *    kept unlinked).
 * 2. Delete the stored files: each material's own path, then everything under the user's folder.
 *    A file that is already gone counts as deleted. If any storage fails, stop here: the account
 *    still exists, so the student can try again and the next attempt finishes the job.
 * 3. Delete the account row in one transaction. Every table hangs off it with ON DELETE CASCADE
 *    (directly or through a course), except the spend ledger, whose rows are unlinked and kept so
 *    the global daily cap cannot be lowered by deleting an account. The row is locked first, so
 *    spend recorded at the same moment waits and lands unlinked too.
 * 4. Sweep the user's folder once more, best effort: an upload that was mid-way during step 2
 *    lands in the folder, and its row was removed in step 3. An upload that finishes later cannot
 *    write its row (the course is gone), and the upload route deletes its file when that fails.
 *
 * Every step can run twice: a second call after a partial failure picks up where the first stopped,
 * and a call for an account that is already gone succeeds.
 */

export type DeletionStore = {
  /** True while the account row exists. */
  accountExists(userId: string): Promise<boolean>
  /** Ends the account's pending and processing jobs. Returns how many were stopped. */
  stopJobs(userId: string): Promise<number>
  /** The storage path of every file the account uploaded. */
  storedFilePaths(userId: string): Promise<string[]>
  /** One transaction: unlink the account's ledger rows, then delete the account row (and, by
   * cascade, everything it owns). False when the row was already gone. */
  removeAccount(userId: string): Promise<boolean>
}

export type DeletionFiles = {
  /** Deletes one stored file. Resolves when the file is gone, including when it never existed. */
  deleteFile(path: string): Promise<void>
  /** Deletes everything under the user's folder in every storage. Throws when a storage fails. */
  deleteUserFiles(userId: string): Promise<void>
}

export type DeletionLog = {
  info: (message: string) => void
  error: (message: string, error?: unknown) => void
}

export type DeletionStep = 'jobs' | 'files' | 'account'

/** A step failed. Nothing after it ran, and the account still exists unless the step was 'account'
 * and the database says otherwise; calling deleteAccount again retries from the start. */
export class AccountDeletionError extends Error {
  constructor(
    readonly step: DeletionStep,
    readonly cause?: unknown
  ) {
    super(`Account deletion stopped at the ${step} step`)
    this.name = 'AccountDeletionError'
  }
}

export type DeletionResult = {
  outcome: 'deleted' | 'already_deleted'
  stoppedJobs: number
  deletedFiles: number
}

export async function deleteAccount(
  userId: string,
  { store, files, log = console }: { store: DeletionStore; files: DeletionFiles; log?: DeletionLog }
): Promise<DeletionResult> {
  if (!(await store.accountExists(userId))) {
    // A previous attempt deleted the row; make sure its files went too.
    await sweep(userId, files, log)
    return { outcome: 'already_deleted', stoppedJobs: 0, deletedFiles: 0 }
  }

  let stoppedJobs: number
  try {
    stoppedJobs = await store.stopJobs(userId)
  } catch (error) {
    log.error(`[ACCOUNT] Could not stop the jobs of account ${userId}:`, error)
    throw new AccountDeletionError('jobs', error)
  }

  let paths: string[]
  try {
    paths = (await store.storedFilePaths(userId)).filter(Boolean)
  } catch (error) {
    log.error(`[ACCOUNT] Could not list the files of account ${userId}:`, error)
    throw new AccountDeletionError('files', error)
  }
  // Try every file before giving up, so a retry has less left to do.
  const failures: unknown[] = []
  for (const path of paths) {
    try {
      await files.deleteFile(path)
    } catch (error) {
      failures.push(error)
      log.error(`[ACCOUNT] Could not delete ${path} for account ${userId}:`, error)
    }
  }
  try {
    await files.deleteUserFiles(userId)
  } catch (error) {
    failures.push(error)
    log.error(`[ACCOUNT] Could not delete the folder of account ${userId}:`, error)
  }
  if (failures.length > 0) throw new AccountDeletionError('files', failures[0])

  let removed: boolean
  try {
    removed = await store.removeAccount(userId)
  } catch (error) {
    log.error(`[ACCOUNT] Could not delete the row of account ${userId}:`, error)
    throw new AccountDeletionError('account', error)
  }

  await sweep(userId, files, log)
  log.info(
    `[ACCOUNT] Deleted account ${userId}: ${stoppedJobs} job(s) stopped, ${paths.length} file(s) deleted` +
      (removed ? '' : ' (the row was already gone)')
  )
  return { outcome: removed ? 'deleted' : 'already_deleted', stoppedJobs, deletedFiles: paths.length }
}

async function sweep(userId: string, files: DeletionFiles, log: DeletionLog) {
  try {
    await files.deleteUserFiles(userId)
  } catch (error) {
    // The account is gone and cannot retry: leave a line to clean up by hand.
    log.error(`[ACCOUNT] Account ${userId} is deleted, but its folder could not be swept; remove ${userId}/ by hand:`, error)
  }
}

/** What the student types to confirm. */
export const CONFIRM_WORD = 'DELETE'

/** True when the typed text confirms the deletion: the word, ignoring surrounding spaces. */
export function confirmsDeletion(typed: string): boolean {
  return typed.trim() === CONFIRM_WORD
}
