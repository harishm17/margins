/**
 * Upload size and file-type checks that run while the file streams to storage, so a big
 * or wrong file is refused without being read into memory first.
 */

import { Transform } from 'stream'

export const DEFAULT_MAX_UPLOAD_MB = 25
/** No setting raises the limit past this. The AI service refuses larger files too (MAX_FILE_BYTES in parse_types.py). */
export const MAX_CONFIGURABLE_MB = 50

/** The upload limit in bytes: MAX_UPLOAD_MB (default 25), read each time so a restart is not needed in tests. */
export function maxUploadBytes(env: Record<string, string | undefined> = process.env): number {
  return maxUploadMb(env) * 1024 * 1024
}

export function maxUploadMb(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.MAX_UPLOAD_MB)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_UPLOAD_MB
  return Math.min(Math.floor(parsed) || 1, MAX_CONFIGURABLE_MB)
}

export type LengthCheck =
  | { ok: true; length: number }
  | { ok: false; status: 400 | 411 | 413; message: string }

/**
 * Judge an upload by its Content-Length header alone, before any of the body is read.
 * A missing or malformed length is refused too: the limit cannot be checked up front without it.
 */
export function checkContentLength(header: string | null | undefined, maxBytes: number): LengthCheck {
  if (header === null || header === undefined || header.trim() === '') {
    return { ok: false, status: 411, message: 'The upload must state its size (Content-Length).' }
  }
  if (!/^\d+$/.test(header.trim())) {
    return { ok: false, status: 400, message: 'The upload has an invalid Content-Length.' }
  }
  const length = Number(header.trim())
  if (length === 0) return { ok: false, status: 400, message: 'The file is empty.' }
  if (length > maxBytes) {
    return { ok: false, status: 413, message: `File must be ${formatLimit(maxBytes)} or smaller.` }
  }
  return { ok: true, length }
}

export function formatLimit(maxBytes: number): string {
  return `${Math.round(maxBytes / (1024 * 1024))} MB`
}

export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`File must be ${formatLimit(maxBytes)} or smaller.`)
    this.name = 'UploadTooLargeError'
  }
}

export class InvalidSignatureError extends Error {
  constructor(public readonly extension: string) {
    super(`Uploaded file failed signature validation for ${extension.toUpperCase()}`)
    this.name = 'InvalidSignatureError'
  }
}

export class IncompleteUploadError extends Error {
  constructor() {
    super('The upload ended before the whole file arrived.')
    this.name = 'IncompleteUploadError'
  }
}

/**
 * Counts the bytes passing through and fails the stream once they exceed the limit. This
 * backs up the Content-Length check for a client that sends more than it announced.
 */
export function createSizeLimiter(maxBytes: number, expectedBytes?: number) {
  let seen = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > maxBytes) return callback(new UploadTooLargeError(maxBytes))
      callback(null, chunk)
    },
    flush(callback) {
      if (expectedBytes !== undefined && seen !== expectedBytes) return callback(new IncompleteUploadError())
      callback()
    },
  })
  return { stream, bytesSeen: () => seen }
}

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Does the start of the file match its extension? `head` is at least the first 8 bytes (or the whole file if shorter). */
export function hasValidSignature(extension: string, head: Buffer): boolean {
  if (extension === '.pdf') return head.subarray(0, 5).toString('ascii') === '%PDF-'
  if (extension === '.docx' || extension === '.pptx') {
    if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return false
    const pair = `${head[2]}.${head[3]}`
    return pair === '3.4' || pair === '5.6' || pair === '7.8'
  }
  if (extension === '.doc') return head.length >= 8 && head.subarray(0, 8).equals(OLE_SIGNATURE)
  return false
}

/** Checks the first bytes against the extension, then passes everything through untouched. */
export function createSignatureCheck(extension: string) {
  let head = Buffer.alloc(0)
  let checked = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!checked) {
        head = Buffer.concat([head, chunk])
        if (head.length >= 8) {
          checked = true
          if (!hasValidSignature(extension, head)) return callback(new InvalidSignatureError(extension))
        }
      }
      callback(null, chunk)
    },
    flush(callback) {
      // A file shorter than 8 bytes never reached the check in transform.
      if (!checked && !hasValidSignature(extension, head)) return callback(new InvalidSignatureError(extension))
      callback()
    },
  })
}
