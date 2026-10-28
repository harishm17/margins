/**
 * The one way the browser calls the app's own API.
 *
 * The routes answer errors in three shapes:
 *   A  { error: "message", details? }
 *   B  { error: { code, message, details? } }
 *   C  B with a more specific code in details.code (ATTEMPT_EXPIRED, LLM_DAILY_BUDGET, ...)
 * `parseApiError` reads all three and `apiFetch` throws an `ApiError` with one shape, so a
 * screen only ever shows `error.message`.
 */

import { fillResetTime } from '@/lib/budget/copy'

export type ApiErrorInit = {
  status: number
  code: string
  message: string
  details?: unknown
  body?: unknown
  retryAfterSeconds?: number | null
}

export class ApiError extends Error {
  readonly status: number
  /** The most specific code: `details.code`, else the typed code, else one derived from the status. */
  readonly code: string
  readonly details: unknown
  /** The parsed JSON body, for extra fields such as `submissionId`. */
  readonly body: unknown
  readonly retryAfterSeconds: number | null

  constructor(init: ApiErrorInit) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.details = init.details
    this.body = init.body
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

export function codeFromStatus(status: number): string {
  if (status === 0) return 'NETWORK'
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'UPSTREAM_ERROR'
  if (status >= 400) return 'INVALID_INPUT'
  return 'UNKNOWN'
}

export function defaultMessage(status: number): string {
  if (status === 0) return 'You seem to be offline. Check your connection and try again.'
  if (status === 401) return 'You are signed out. Sign in again to continue.'
  if (status === 403) return 'You do not have access to that.'
  if (status === 404) return 'We could not find that.'
  if (status === 413) return 'That file is too large.'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  return 'Something went wrong. Try again.'
}

/** Turn a failed response (status, parsed body, headers) into an ApiError. */
export function parseApiError(status: number, body: unknown, headers?: Pick<Headers, 'get'>): ApiError {
  let message: string | null = null
  let code: string | null = null
  let details: unknown

  if (isRecord(body)) {
    const error = body.error
    if (typeof error === 'string') {
      // Shape A.
      message = nonEmptyString(error)
      details = body.details
    } else if (isRecord(error)) {
      // Shape B.
      message = nonEmptyString(error.message)
      code = nonEmptyString(error.code)
      details = error.details
    } else {
      message = nonEmptyString(body.message)
    }
    // Shape C: a more specific code nested in the details.
    if (isRecord(details)) {
      const nested = nonEmptyString(details.code)
      if (nested) code = nested
    }
  }

  const retryAfter = Number(headers?.get('retry-after'))
  return new ApiError({
    status,
    code: code ?? codeFromStatus(status),
    // A message from the server may have the daily-allowance reset time as a token (the server
    // does not know the student's time zone); the browser fills it in.
    message: fillResetTime(message ?? defaultMessage(status)),
    details,
    body,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  })
}

export type ApiFetchInit = Omit<RequestInit, 'body'> & {
  /** Sent as the JSON body, with the content type set. */
  json?: unknown
  body?: BodyInit | null
}

/** Fetch JSON from the app's API. Throws ApiError for any non-2xx answer or a network failure. */
export async function apiFetch<T = unknown>(url: string, init: ApiFetchInit = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const requestHeaders = new Headers(headers)
  if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json')
  let body = rest.body
  if (json !== undefined) {
    requestHeaders.set('content-type', 'application/json')
    body = JSON.stringify(json)
  }

  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', ...rest, headers: requestHeaders, body })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError({ status: 0, code: 'NETWORK', message: defaultMessage(0) })
  }

  const text = await response.text().catch(() => '')
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) throw parseApiError(response.status, parsed, response.headers)
  return parsed as T
}
