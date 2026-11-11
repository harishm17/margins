/**
 * Files that a deleted row used to point to.
 *
 * Deleting a row and then its file are two steps in two systems, so a crash or a storage error between them used to
 * leave a file nobody points at (and, in the other order, a row pointing at nothing). The path is queued in
 * `pending_file_deletions` in the SAME transaction as the row delete, so the delete and the promise to remove the
 * file commit together; the AI service's reaper loop removes the objects, retrying with backoff, and its watchdog
 * alerts on rows that stay stuck. Deleting the file right after the commit is only a shortcut: the queue row is the
 * guarantee. A row goes once its file is gone: its path names the account and the course, and a deleted account
 * leaves nothing that names it.
 *
 * A path ending in `/` is a folder (everything under it).
 */
import { logServerError } from '@/lib/ops/log'
import type { Prisma } from '@prisma/client'
import { deleteFile, deleteStoredFolder } from './files'

type QueueDb = Pick<Prisma.TransactionClient, 'pendingFileDeletion'>

/** Queue `paths` for deletion through `db` (pass the transaction client that deletes the rows). Returns the queued paths. */
export async function queueFileDeletions(
  db: QueueDb,
  paths: ReadonlyArray<string | null | undefined>,
  reason: string
): Promise<string[]> {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))]
  if (unique.length > 0) {
    await db.pendingFileDeletion.createMany({ data: unique.map((path) => ({ path, reason })) })
  }
  return unique
}

/**
 * After the transaction committed: try to delete the queued files now and remove their rows. A failure is only
 * logged; the reaper loop retries it.
 */
export async function deleteQueuedFilesNow(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const { prisma } = await import('@/lib/db/prisma')
  for (const path of paths) {
    try {
      if (path.endsWith('/')) await deleteStoredFolder(path)
      else await deleteFile(path)
      await prisma.pendingFileDeletion.deleteMany({ where: { path } })
    } catch (error) {
      logServerError('Storage: could not delete a file right away; the deletion queue will retry', error)
    }
  }
}
