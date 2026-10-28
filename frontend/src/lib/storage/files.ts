/**
 * Material file storage: an S3-compatible bucket (S3_BUCKET set), Google Cloud Storage
 * (ENABLE_GCS_STORAGE=true) or the local uploads folder.
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

// Lazy-load Storage to avoid credential errors in development
let storageInstance: any = null
const CLOUD_STORAGE_ENABLED = process.env.ENABLE_GCS_STORAGE === 'true'
const ALLOW_LOCAL_FALLBACK = process.env.ALLOW_GCS_LOCAL_FALLBACK !== 'false'
const BUCKET_NAME = process.env.GCS_BUCKET || 'margins-materials'
const LOCAL_UPLOAD_BASE = process.env.LOCAL_UPLOADS_DIR || '/data/uploads'
const LOCAL_UPLOAD_FALLBACK_BASE = '/tmp/margins-uploads'

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
      return `gs://${BUCKET_NAME}/${storagePath}`
    } catch (error) {
      fs.rmSync(localFilePath, { force: true })
      throw error
    }
  }

  throw new Error(`[LOCAL_STORAGE] Failed to write uploaded file: ${String(lastError)}`)
}

async function deleteLocalFile(relativePath: string): Promise<void> {
  const fs = await import('fs')
  const pathModule = await import('path')
  const bases = [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]

  for (const base of bases) {
    // Runtime upload folder, not project files: keep Turbopack from tracing the whole project.
    const localFilePath = pathModule.join(/* turbopackIgnore: true */ base, relativePath)
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath)
      return
    }
  }
}

async function deleteLocalFolder(relativeFolder: string): Promise<void> {
  const fs = await import('fs')
  const pathModule = await import('path')
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    const root = pathModule.resolve(/* turbopackIgnore: true */ base)
    const folder = pathModule.resolve(/* turbopackIgnore: true */ root, relativeFolder)
    // Never remove the upload root itself or anything outside it.
    if (folder === root || !folder.startsWith(root + pathModule.sep)) continue
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

async function getStorage() {
  if (!CLOUD_STORAGE_ENABLED) {
    return null
  }

  if (!process.env.GCS_PROJECT_ID) {
    console.warn('[GCS] ENABLE_GCS_STORAGE=true but GCS_PROJECT_ID is missing. Falling back to local storage.')
    return null
  }

  // In production, lazy-load Storage only when needed
  if (!storageInstance) {
    try {
      const { Storage } = await import('@google-cloud/storage')
      storageInstance = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
      })
    } catch (error) {
      console.warn('[GCS] Failed to initialize Storage client:', error)
      return null
    }
  }

  return storageInstance
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
 * and straight to GCS or disk without being held in memory. If a transform rejects the
 * stream, or the upload fails part way, nothing is left in storage.
 *
 * There is no fallback from GCS to local disk after a failure, because the source has already
 * been read. The client simply uploads again.
 * @returns GCS path (gs://bucket/path)
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

  const storage = await getStorage()

  if (!storage) {
    return writeLocalStream(source, transforms, storagePath)
  }

  const { pipeline } = await import('stream/promises')
  const blob = storage.bucket(BUCKET_NAME).file(storagePath)
  try {
    await pipeline([
      source,
      ...transforms,
      blob.createWriteStream({
        resumable: false,
        metadata: { contentType: inferContentType(storagePath, contentType) },
      }),
    ])
    return `gs://${BUCKET_NAME}/${storagePath}`
  } catch (error) {
    await blob.delete({ ignoreNotFound: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Generate a signed URL for downloading a file
 * @param gcsPath - Full GCS path (gs://bucket/path)
 * @param expiresInMinutes - URL expiration time (default: 60 minutes)
 * @returns Signed URL
 */
export async function getSignedUrl(
  gcsPath: string,
  expiresInMinutes = 60
): Promise<string> {
  const storage = await getStorage()
  
  if (!storage) {
    // Development mode - return a mock URL
    return `http://localhost:4566/${gcsPath.replace('gs://', '')}`
  }

  // Extract path from gs://bucket/path
  const path = gcsPath.replace(`gs://${BUCKET_NAME}/`, '')

  const bucket = storage.bucket(BUCKET_NAME)
  const file = bucket.file(path)

  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInMinutes * 60 * 1000,
  })

  return url
}

/**
 * Delete a file from GCS
 * @param gcsPath - Full GCS path (gs://bucket/path)
 */
export async function deleteFile(gcsPath: string): Promise<void> {
  const s3Path = parseS3Path(gcsPath)
  if (s3Path) {
    await deleteS3Object(s3Path.bucket, s3Path.key)
    return
  }

  const storage = await getStorage()
  
  if (!storage) {
    const relativePath = gcsPath.replace(`gs://${BUCKET_NAME}/`, '')
    await deleteLocalFile(relativePath)
    return
  }

  const path = gcsPath.replace(`gs://${BUCKET_NAME}/`, '')
  const bucket = storage.bucket(BUCKET_NAME)
  try {
    await bucket.file(path).delete()
  } catch (error) {
    if (ALLOW_LOCAL_FALLBACK) {
      console.warn(`[GCS] Delete of ${path} failed, trying local storage instead:`, error)
      await deleteLocalFile(path)
      return
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
export async function deleteFilesBestEffort(gcsPaths: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const gcsPath of gcsPaths) {
    if (!gcsPath) continue
    try {
      await deleteFile(gcsPath)
    } catch (error) {
      failed.push(gcsPath)
      console.error(`[STORAGE] Could not delete ${gcsPath}; remove it by hand:`, error)
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
    // Uploads can be on local disk even with GCS on (the upload fallback), so sweep both.
    await deleteLocalFolder(folder)
    if (s3Configured()) {
      await deleteS3Prefix(folder)
    }
    const storage = await getStorage()
    if (storage) {
      await storage.bucket(BUCKET_NAME).deleteFiles({ prefix: folder, force: true })
    }
    return true
  } catch (error) {
    console.error(`[STORAGE] Could not delete the folder ${folder}; remove it by hand:`, error)
    return false
  }
}

/**
 * Generate GCS path for a material upload
 * @param userId - User ID
 * @param projectId - Project ID
 * @param materialId - Material ID
 * @param filename - Original filename
 * @returns GCS path
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
 * Open a stored material for reading. Like the AI service, a `gs://` path is looked up in
 * the local upload folders first (uploads can be on disk even with GCS on), then in the
 * bucket. Returns null when the file is in neither place.
 */
export async function openStoredFile(gcsPath: string): Promise<StoredFile | null> {
  const s3Path = parseS3Path(gcsPath)
  if (s3Path) {
    return openS3Object(s3Path.bucket, s3Path.key)
  }

  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsPath)
  if (!match) return null
  const [, bucketName, blobPath] = match

  const fs = await import('fs')
  const pathModule = await import('path')
  for (const base of [LOCAL_UPLOAD_BASE, LOCAL_UPLOAD_FALLBACK_BASE]) {
    // Runtime upload folder, not project files: keep Turbopack from tracing the whole project.
    const root = pathModule.resolve(/* turbopackIgnore: true */ base)
    const candidate = pathModule.resolve(/* turbopackIgnore: true */ root, blobPath)
    // The path comes from the database, but never read outside the upload folder.
    if (!candidate.startsWith(root + pathModule.sep)) continue
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

  const storage = await getStorage()
  if (!storage) return null
  const file = storage.bucket(bucketName).file(blobPath)
  try {
    const [metadata] = await file.getMetadata()
    return {
      size: Number(metadata.size),
      stream: (range) => file.createReadStream(range),
    }
  } catch (error) {
    if ((error as { code?: number })?.code === 404) return null
    throw error
  }
}
