/** The voice routes, as the browser calls them. */
import { apiFetch, ApiError, isApiError, parseApiError } from '@/lib/api/client'

export type VoiceUsage = {
  dailyMinutes: number
  usedSeconds: number
  remainingSeconds: number
  hasLiveSession: boolean
}

export type VoiceStyle = 'oral_quiz' | 'guided_notes' | 'topic_conversation'

export type CreateSessionInput = {
  projectId: string
  mode: 'topic_drill' | 'sprint'
  topicId?: string
  style: VoiceStyle
  focus: string | null
  language: string
}

export type CreatedSession = {
  sessionId: string
  questionCount: number
  mode: 'topic_drill' | 'sprint'
  style: VoiceStyle
  focus: string | null
}

export const getVoiceUsage = (signal?: AbortSignal) => apiFetch<VoiceUsage>('/api/voice/usage', { signal })

export const createVoiceSession = (input: CreateSessionInput) =>
  apiFetch<CreatedSession>('/api/voice/session', { method: 'POST', json: input })

/** True for the 422 that asks the student to create notes and a quiz first. */
export function requiresGeneration(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 422 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    (error.body as { requiresGeneration?: unknown }).requiresGeneration === true
  )
}

type SessionPatch = {
  sessionId: string
  status?: 'active' | 'ended' | 'aborted'
  heartbeat?: boolean
  incrementInterruptCount?: number
  lastDetectedLanguage?: string | null
}

/**
 * PATCH the session and ignore the answer. `keepalive` lets the request finish while the page
 * is closing (pagehide); a failed update never matters to the student, so errors are swallowed.
 */
export function patchVoiceSession(patch: SessionPatch, options: { keepalive?: boolean } = {}): Promise<void> {
  return fetch('/api/voice/session', {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive: options.keepalive ?? false,
  }).then(
    () => undefined,
    () => undefined
  )
}

export type TurnMetrics = { ttftMs?: number; ttfaMs?: number; responseMs?: number }

export function postVoiceMetrics(sessionId: string, entry: TurnMetrics): void {
  const clean = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
  if (Object.keys(clean).length === 0) return
  void fetch('/api/voice/metrics', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, entry: clean }),
  }).catch(() => undefined)
}

/**
 * Open one turn. Resolves with the streaming response; a non-200 answer (the stream never
 * started) throws an ApiError whose `code` is `error.details.code` (SESSION_ENDED, ...).
 */
export async function openVoiceTurn(sessionId: string, utterance: string, signal: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch('/api/voice/turn', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ sessionId, utterance }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError({ status: 0, code: 'NETWORK', message: 'You seem to be offline.' })
  }
  if (response.ok && response.body) return response
  const body: unknown = await response.json().catch(() => undefined)
  throw parseApiError(response.status, body, response.headers)
}
