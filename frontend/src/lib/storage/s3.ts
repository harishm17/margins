/**
 * S3-compatible object storage (Railway Buckets, AWS S3, Cloudflare R2, MinIO).
 * On when S3_BUCKET is set; materials are then stored as `s3://bucket/key`.
 */

import type { Readable, Transform } from 'stream'
import type { S3Client } from '@aws-sdk/client-s3'

let clientInstance: S3Client | null = null

export function s3Bucket(): string {
  return process.env.S3_BUCKET || ''
}

export function s3Configured(): boolean {
  return Boolean(s3Bucket())
}

/** `s3://bucket/key` → { bucket, key }, or null for any other path. */
export function parseS3Path(storagePath: string): { bucket: string; key: string } | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(storagePath)
  return match ? { bucket: match[1], key: match[2] } : null
}

async function getClient(): Promise<S3Client> {
  if (!clientInstance) {
    const { S3Client } = await import('@aws-sdk/client-s3')
    const accessKeyId = process.env.S3_ACCESS_KEY_ID
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
    clientInstance = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      // Checksums only where S3 requires them: not every S3-compatible store accepts the
      // SDK's default ones.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }
  return clientInstance
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

/**
 * Upload a stream. The bytes go through `transforms` into a temp file first, so a refused
 * upload (too big, wrong signature) fails with the transform's own error and never reaches
 * the bucket; the file is then sent with a known length in one request.
 */
export async function uploadStreamToS3(
  source: Readable,
  key: string,
  contentType: string,
  transforms: Transform[]
): Promise<string> {
  const fs = await import('fs')
  const os = await import('os')
  const pathModule = await import('path')
  const { pipeline } = await import('stream/promises')
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')

  const tempDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'margins-upload-'))
  const tempFile = pathModule.join(tempDir, 'upload')
  try {
    await pipeline([source, ...transforms, fs.createWriteStream(tempFile)])
    const client = await getClient()
    await client.send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: fs.createReadStream(tempFile),
        ContentLength: fs.statSync(tempFile).size,
        ContentType: contentType,
      })
    )
    return `s3://${s3Bucket()}/${key}`
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await getClient()
  // S3 answers a delete of a missing key with success, so a repeat delete is harmless. Some
  // S3-compatible stores answer 404 instead: that also means the object is gone.
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

/** Delete every object under `prefix` in the configured bucket. */
export async function deleteS3Prefix(prefix: string): Promise<void> {
  const { ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await getClient()
  let continuationToken: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Bucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )
    // One delete per object: DeleteObjects needs a Content-MD5 that some stores reject
    // when checksums are off, and a project holds few files.
    for (const object of page.Contents ?? []) {
      if (object.Key) {
        await client.send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: object.Key }))
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)
}

/**
 * Open an object for reading: its size, and a stream of all of it or an inclusive byte
 * range. Returns null when the object does not exist.
 */
export async function openS3Object(
  bucket: string,
  key: string
): Promise<{ size: number; stream: (range?: { start: number; end: number }) => Readable } | null> {
  const { HeadObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3')
  const { PassThrough, Readable } = await import('stream')
  const client = await getClient()

  let size: number
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    size = Number(head.ContentLength ?? 0)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }

  return {
    size,
    stream: (range) => {
      // The caller wants a stream right away; the request starts behind it.
      const out = new PassThrough()
      const abort = new AbortController()
      out.on('close', () => abort.abort())
      client
        .send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: range ? `bytes=${range.start}-${range.end}` : undefined,
          }),
          { abortSignal: abort.signal }
        )
        .then((response) => {
          const body = response.Body as Readable | undefined
          if (!body) throw new Error(`Empty response body for s3://${bucket}/${key}`)
          const source = body instanceof Readable ? body : Readable.from(body as AsyncIterable<Uint8Array>)
          source.on('error', (error) => out.destroy(error))
          source.pipe(out)
        })
        .catch((error) => out.destroy(error))
      return out
    },
  }
}
