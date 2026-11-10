/**
 * Material file storage: an S3-compatible bucket (S3_BUCKET set; production) or the local
 * uploads folder (local runs, e2e).
 *
 * Stored paths, as recorded in `materials.gcs_path`:
 * - `s3://bucket/key` for the bucket;
 * - `local://path` for the local uploads folder;
 * - `gs://bucket/path` for local uploads made before `local://` existed. The bucket name was
 *   never used for them, so they are read and deleted exactly like `local://path`.
 */

import { describeErrorForOps, logServerError } from '@/lib/ops/log'
import type { Readable, Transform } from 'stream'
import {
  deleteS3Object,
  deleteS3Prefix,
  openS3Object,
  parseS3Path,
  putS3Object,
  s3Bucket,
  s3Configured,
  uploadStreamToS3,
} from './s3'
import { recordOpsEvent } from '@/lib/ops/events'

const LOCAL_UPLOAD_BASE = process.env.LOCAL_UPLOADS_DIR || '/data/uploads'
const LOCAL_UPLOAD_FALLBACK_BASE = '/tmp/margins-uploads'
const LOCAL_PREFIX = 'local://'

/**
 * The path inside the uploads folder of a local material (`local://path`, or the older
 * `gs://bucket/path`), or null for any other stored path.
 */
export function parseLocalPath(storagePath: string): string | null {
  if (storagePath.startsWith(LOCAL_PREFIX)) {
    return storagePath.slice(LOCAL_PREFIX.length) || null
  }
  const legacy = /^gs:\/\/[^/]+\/(.+)$/.exec(storagePath)
  return legacy ? legacy[1] : null
}

/**
 * A file inside one upload folder, or null when the relative path would leave it. Paths come
 * from the database, but nothing outside the upload folder is ever read or removed.
 */
async function insideUploads(base: string, relativePath: string): Promise<string | null> {
  const pathModule = await import('path')
  // Runtime upload folder, not project files: keep Turbopack from tracing the whole project.
  const root = pathModule.resolve(/* turbopackIgnore: true */ base)
  const candidate = pathModule.resolve(/* turbopackIgnore: true */ root, relativePath)
  return candidate.startsWith(root + pathModule.sep) ? candidate : null
}

/**
 * Stream a file to local disk. The first writable upload folder is chosen before any byte is
 * read, because a stream cannot be replayed into a second folder. A failed or refused upload
 * leaves no partial file behind.
 */
async function writeLocalStream(
  source: Readable,
  transforms: Transform[],
  storagePath: string
): Promise<string> {
  const fs = await import('fs')
  const pathModule = await import('path')
  const { pipeline } = await import('stream/promises')

  let lastError: unknown = null
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    // Runtime upload folder, not project files: keep Turbopack from tracing the whole project.
    const localFilePath = pathModule.join(/* turbopackIgnore: true */ base, storagePath)
    try {
      fs.mkdirSync(pathModule.dirname(localFilePath), { recursive: true })
      fs.accessSync(pathModule.dirname(localFilePath), fs.constants.W_OK)
    } catch (error) {
      lastError = error
      continue
    }
    try {
      await pipeline([source, ...transforms, fs.createWriteStream(localFilePath)])
      console.log('[LOCAL_STORAGE] File stored successfully')
      return `${LOCAL_PREFIX}${storagePath}`
    } catch (error) {
      fs.rmSync(localFilePath, { force: true })
      throw error
    }
  }

  throw new Error(`[LOCAL_STORAGE] Failed to write uploaded file: ${String(lastError)}`)
}

async function deleteLocalFile(relativePath: string): Promise<void> {
  const fs = await import('fs')
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    const localFilePath = await insideUploads(base, relativePath)
    // force: a file that is already gone (or went between two calls) counts as deleted.
    if (localFilePath) fs.rmSync(localFilePath, { force: true })
  }
}

async function deleteLocalFolder(relativeFolder: string): Promise<void> {
  const fs = await import('fs')
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    // Never remove the upload root itself or anything outside it.
    const folder = await insideUploads(base, relativeFolder)
    if (!folder) continue
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

function inferContentType(storagePath: string, provided?: string): string {
  if (provided && provided.trim()) {
    return provided
  }
  const lowerPath = storagePath.toLowerCase()
  if (lowerPath.endsWith('.pdf')) return 'application/pdf'
  if (lowerPath.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (lowerPath.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  if (lowerPath.endsWith('.doc')) return 'application/msword'
  return 'application/octet-stream'
}

/**
 * Upload a file as a stream: the bytes go through `transforms` (size limit, signature check)
 * and on to the bucket or disk without being held in memory. If a transform rejects the
 * stream, or the upload fails part way, nothing is left in storage. There is no retry here,
 * because the source has already been read; the client simply uploads again.
 * @returns The stored path (`s3://bucket/key` or `local://path`)
 */
export async function uploadStream(
  source: Readable,
  storagePath: string,
  contentType?: string,
  transforms: Transform[] = []
): Promise<string> {
  if (s3Configured()) {
    return uploadStreamToS3(source, storagePath, inferContentType(storagePath, contentType), transforms)
  }
  return writeLocalStream(source, transforms, storagePath)
}

/**
 * Delete one stored file. A file that is already gone counts as deleted, on every backend, so
 * cleanup can be retried; a path that is neither in the bucket nor in the upload folder is
 * ignored.
 */
export async function deleteFile(storagePath: string): Promise<void> {
  const s3Path = parseS3Path(storagePath)
  if (s3Path) {
    await deleteS3Object(s3Path.bucket, s3Path.key)
    return
  }
  const localPath = parseLocalPath(storagePath)
  if (localPath) {
    await deleteLocalFile(localPath)
  }
}

/** The stored-path form of a folder under the uploads root (`<userId>/<projectId>/`), for the deletion queue. */
export function storedFolderPath(folder: string): string {
  const normalized = folder.endsWith('/') ? folder : `${folder}/`
  return s3Configured() ? `s3://${s3Bucket()}/${normalized}` : `${LOCAL_PREFIX}${normalized}`
}

/** Delete everything under a folder path made by `storedFolderPath`. Missing folders count as deleted. */
export async function deleteStoredFolder(storagePath: string): Promise<void> {
  const s3Path = parseS3Path(storagePath)
  if (s3Path) {
    await deleteS3Prefix(s3Path.key)
    return
  }
  const localPath = parseLocalPath(storagePath)
  if (localPath) await deleteLocalFolder(localPath)
}

/**
 * A delete that failed where no row delete could carry the queue entry (a stored file whose row was never written,
 * the folder of an account that is already gone): put the path in the deletion queue so the reaper retries it.
 * Never throws; the failure is already logged.
 */
export async function queueDeletionAfterFailure(storagePath: string, reason: string): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    await prisma.pendingFileDeletion.create({ data: { path: storagePath, reason } })
  } catch (error) {
    logServerError('Storage: could not queue a file for deletion either; remove it by hand', error)
  }
}

/**
 * Record a file that was just stored. `record` makes the database rows that point at it; if it
 * fails for any reason (the course or the account was deleted meanwhile, the database refused the
 * row), the stored file is deleted before the error goes on, so a failed upload never leaves a file
 * that nothing points at. Every write-then-record path goes through this.
 */
export async function recordStoredFile<T>(
  storedPath: string,
  record: () => Promise<T>,
  remove: (path: string) => Promise<void> = deleteFile
): Promise<T> {
  try {
    return await record()
  } catch (error) {
    try {
      await remove(storedPath)
    } catch (cleanupError) {
      logServerError('Storage: could not delete a file after its record failed; remove it by hand', cleanupError)
      await recordOpsEvent('storage_delete_failed', `${storedPath} (after its record failed): ${describeErrorForOps(cleanupError)}`)
      await queueDeletionAfterFailure(storedPath, 'record_failed')
    }
    throw error
  }
}

/**
 * Delete files after their database rows are already gone. A failure is logged with the
 * path (so it can be cleaned up by hand) and never thrown: the user's delete has already
 * succeeded and must not turn into an error because storage hiccuped.
 * Returns the paths that could not be deleted.
 */
export async function deleteFilesBestEffort(storagePaths: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const storagePath of storagePaths) {
    if (!storagePath) continue
    try {
      await deleteFile(storagePath)
    } catch (error) {
      failed.push(storagePath)
      logServerError('Storage: could not delete a file; remove it by hand', error)
      await recordOpsEvent('storage_delete_failed', `${storagePath}: ${describeErrorForOps(error)}`)
    }
  }
  return failed
}

/**
 * Delete everything stored for a project (user/project/...), including files whose
 * database rows were already removed. Best effort, like deleteFilesBestEffort.
 */
export async function deleteProjectFolder(userId: string, projectId: string): Promise<boolean> {
  const folder = `${userId}/${projectId}/`
  try {
    // Sweep the local folder even with a bucket: uploads made before the bucket was set
    // up stay on disk.
    await deleteLocalFolder(folder)
    if (s3Configured()) {
      await deleteS3Prefix(folder)
    }
    return true
  } catch (error) {
    logServerError('Storage: could not delete a folder; remove it by hand', error)
    await recordOpsEvent('storage_delete_failed', `folder ${folder}: ${describeErrorForOps(error)}`)
    return false
  }
}

/**
 * Delete everything stored for a user: every file under `<userId>/`, in the bucket and in the
 * local uploads folder, including files whose database rows are already gone. Unlike
 * deleteProjectFolder this throws when a storage fails, so account deletion can stop and be
 * retried; files that are already gone count as deleted, so a retry only finishes the job.
 */
export async function deleteUserFiles(userId: string): Promise<void> {
  // Ids are UUIDs. Anything else could name a folder outside the user's own.
  if (!/^[A-Za-z0-9-]+$/.test(userId)) throw new Error(`Refusing to delete files for user id "${userId}"`)
  const folder = `${userId}/`
  await deleteLocalFolder(folder)
  if (s3Configured()) {
    await deleteS3Prefix(folder)
  }
}

/** Where deletion records live in storage, beside (never inside) any user's folder. */
export const DELETION_RECORDS_PREFIX = 'ops/deletions/'

/**
 * Record that an account was deleted, as `ops/deletions/<userId>.json` in the bucket (or the uploads folder).
 *
 * A restore brings back the database as of the last nightly backup, and an account deleted after that backup would
 * come back with it. The bucket is copied nightly too, and these records with it, so the restore script
 * (scripts/restore_drill.py) deletes every recorded account again. Records hold the id and the time only.
 */
export async function writeDeletionRecord(userId: string, deletedAt: Date = new Date()): Promise<void> {
  if (!/^[A-Za-z0-9-]+$/.test(userId)) throw new Error(`Refusing to record deletion for user id "${userId}"`)
  const key = `${DELETION_RECORDS_PREFIX}${userId}.json`
  const body = JSON.stringify({ userId, deletedAt: deletedAt.toISOString() })
  if (s3Configured()) {
    await putS3Object(key, body, 'application/json')
    return
  }
  const fs = await import('fs')
  const pathModule = await import('path')
  let lastError: unknown = null
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    // Runtime upload folder, not project files: keep Turbopack from tracing the whole project.
    const target = pathModule.join(/* turbopackIgnore: true */ base, key)
    try {
      fs.mkdirSync(pathModule.dirname(target), { recursive: true })
      fs.writeFileSync(target, body)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`[LOCAL_STORAGE] Could not write the deletion record: ${String(lastError)}`)
}

/**
 * The storage path for a material upload: user/project/materials/material/filename.
 */
export function generateMaterialPath(
  userId: string,
  projectId: string,
  materialId: string,
  filename: string
): string {
  // Sanitize filename
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_')
  return `${userId}/${projectId}/materials/${materialId}/${sanitizedFilename}`
}

export type StoredFile = {
  size: number
  /** Streams the file, or the inclusive byte range of it. */
  stream: (range?: { start: number; end: number }) => import('stream').Readable
}

/**
 * Open a stored material for reading, from the bucket or the local upload folders (the
 * same lookup the AI service makes). Returns null when the file is not there.
 */
export async function openStoredFile(storagePath: string): Promise<StoredFile | null> {
  const s3Path = parseS3Path(storagePath)
  if (s3Path) {
    return openS3Object(s3Path.bucket, s3Path.key)
  }

  const localPath = parseLocalPath(storagePath)
  if (!localPath) return null

  const fs = await import('fs')
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    const candidate = await insideUploads(base, localPath)
    if (!candidate) continue
    let stat
    try {
      stat = fs.statSync(candidate)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    return {
      size: stat.size,
      stream: (range) => fs.createReadStream(candidate, range),
    }
  }
  return null
}
