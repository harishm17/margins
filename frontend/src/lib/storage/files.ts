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

import type { Readable, Transform } from 'stream'
import {
  deleteS3Object,
  deleteS3Prefix,
  openS3Object,
  parseS3Path,
  s3Configured,
  uploadStreamToS3,
} from './s3'

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
    if (localFilePath && fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath)
      return
    }
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
 * Delete one stored file. A path that is neither in the bucket nor in the upload folder is
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
      console.error(`[STORAGE] Could not delete ${storagePath}; remove it by hand:`, error)
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
    console.error(`[STORAGE] Could not delete the folder ${folder}; remove it by hand:`, error)
    return false
  }
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
