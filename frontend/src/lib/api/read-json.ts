import type { NextResponse } from 'next/server'
import type { ZodType, z } from 'zod'
import { ApiErrorCode, apiError, apiInvalidInput, zodDetails } from '@/lib/api/errors'

/** The default body limit: far more than any form or answer this app sends. Routes that need more say so. */
export const DEFAULT_MAX_BYTES = 64 * 1024

export type ReadJsonResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse }

const tooLarge = () => apiError(ApiErrorCode.INVALID_INPUT, 'That request is too large.', { code: 'PAYLOAD_TOO_LARGE' }, 413)

/** Reads the raw body as text, refusing past `maxBytes` whether or not the client declared a length. */
export async function readBodyText(request: Request, maxBytes: number): Promise<{ text: string } | { response: NextResponse }> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    // Do not read what we are refusing.
    void request.body?.cancel().catch(() => undefined)
    return { response: tooLarge() }
  }
  if (!request.body) return { text: '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      // A chunked body, or one that lied about its length: stop reading at the limit.
      await reader.cancel().catch(() => undefined)
      return { response: tooLarge() }
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * The one way an API route reads a JSON body. The size is checked from Content-Length first (413), then while
 * streaming, so a chunked body cannot get past it; then the JSON is parsed (400) and checked against `schema` (400
 * with the field details). An empty body is read as `undefined`, which a schema can accept with `.optional()`.
 *
 * `request.json()`, `.text()`, `.formData()` and `.arrayBuffer()` are banned in routes by src/app/api-routes.test.ts.
 */
export async function readJson<S extends ZodType>(
  request: Request,
  schema: S,
  options: { maxBytes?: number } = {}
): Promise<ReadJsonResult<z.output<S>>> {
  const body = await readBodyText(request, options.maxBytes ?? DEFAULT_MAX_BYTES)
  if ('response' in body) return { ok: false, response: body.response }
  let json: unknown
  if (body.text.trim() !== '') {
    try {
      json = JSON.parse(body.text)
    } catch {
      return { ok: false, response: apiInvalidInput('Invalid input') }
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return { ok: false, response: apiInvalidInput('Invalid input', zodDetails(parsed.error)) }
  return { ok: true, data: parsed.data }
}
