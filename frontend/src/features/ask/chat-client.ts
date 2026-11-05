/** Sends one question and reads the NDJSON answer stream. No React here. */
import { parseApiError } from '@/lib/api/client'
import { createLineSplitter, parseChatEvent, type ChatEvent } from '@/lib/chat/events'

export class ChatRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(message: string, code: string, retryable: boolean) {
    super(message)
    this.name = 'ChatRequestError'
    this.code = code
    this.retryable = retryable
  }
}

/** The question never reached the server (or was refused before it was stored). */
export const NOT_SENT_MESSAGE = "Your question wasn't sent. Check your connection, then try again."
/** The server has the question; only the answer was cut short. */
export const INTERRUPTED_MESSAGE = 'The answer was interrupted. Your question is saved; try again.'

export type StreamChatArgs = {
  courseId: string
  question: string
  threadId?: string | null
  topicId?: string | null
  /** The concept a new conversation is about (the knowledge map's "Ask about this"). */
  conceptId?: string | null
  /** The student's "Show me a worked example" button. */
  event?: 'show_worked'
  /** This send's id: sending it again (a retry, a double Enter) never stores the question twice. */
  clientRequestId?: string
  signal: AbortSignal
  onEvent: (event: ChatEvent) => void
}

/** The server already held this send: the conversation its question went to. */
export type StreamChatResult = { duplicateOf: string | null } | undefined

/**
 * Resolves when the stream ends, or with `duplicateOf` when the server already had this send. Rejects with a ChatRequestError when the
 * request is refused before any event (rate limit, budget, validation, offline) or the connection drops, and with an AbortError when the
 * student stops it.
 */
export async function streamChat({
  courseId,
  question,
  threadId,
  topicId,
  conceptId,
  event,
  clientRequestId,
  signal,
  onEvent,
}: StreamChatArgs): Promise<StreamChatResult> {
  let response: Response
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(courseId)}/chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({
        question,
        ...(threadId ? { threadId } : {}),
        ...(topicId ? { topicId } : {}),
        ...(conceptId ? { conceptId } : {}),
        ...(event ? { event } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
      }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ChatRequestError(NOT_SENT_MESSAGE, 'NETWORK', true)
  }

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => undefined)
    const failure = parseApiError(response.status, body, response.headers)
    const details = failure.details as { retryable?: unknown } | undefined
    throw new ChatRequestError(failure.message, failure.code, details?.retryable !== false)
  }

  // A JSON body (not a stream) is the server saying it already took this send.
  if (response.headers.get('content-type')?.includes('application/json')) {
    const body = (await response.json().catch(() => null)) as { duplicate?: boolean; threadId?: string | null } | null
    return { duplicateOf: body?.duplicate && typeof body.threadId === 'string' ? body.threadId : null }
  }

  const reader = response.body.getReader()
  const splitter = createLineSplitter()
  // Once the thread event has been read the server holds the question; before it, nothing is known to be stored.
  let accepted = false
  const emit = (lines: string[]) => {
    for (const line of lines) {
      const parsed = parseChatEvent(line)
      if (!parsed) continue
      if (parsed.type === 'thread') accepted = true
      onEvent(parsed)
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      emit(splitter.push(value))
    }
    emit(splitter.flush())
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // The connection dropped while the answer streamed. The server keeps writing it, so say which half failed.
    throw new ChatRequestError(accepted ? INTERRUPTED_MESSAGE : NOT_SENT_MESSAGE, accepted ? 'CHAT_INTERRUPTED' : 'NETWORK', true)
  }
  return undefined
}
