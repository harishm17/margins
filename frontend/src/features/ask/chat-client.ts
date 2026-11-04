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

export type StreamChatArgs = {
  courseId: string
  question: string
  threadId?: string | null
  topicId?: string | null
  /** The concept a new conversation is about (the knowledge map's "Ask about this"). */
  conceptId?: string | null
  /** The student's "Show me a worked example" button. */
  event?: 'show_worked'
  signal: AbortSignal
  onEvent: (event: ChatEvent) => void
}

/**
 * Resolves when the stream ends. Rejects with a ChatRequestError when the request is refused
 * before any event (rate limit, budget, validation, offline) and with an AbortError when the
 * student stops it.
 */
export async function streamChat({ courseId, question, threadId, topicId, conceptId, event, signal, onEvent }: StreamChatArgs) {
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
      }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ChatRequestError("That didn't go through. Check your connection and try again.", 'NETWORK', true)
  }

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => undefined)
    const failure = parseApiError(response.status, body, response.headers)
    const details = failure.details as { retryable?: unknown } | undefined
    throw new ChatRequestError(failure.message, failure.code, details?.retryable !== false)
  }

  const reader = response.body.getReader()
  const splitter = createLineSplitter()
  const emit = (lines: string[]) => {
    for (const line of lines) {
      const parsed = parseChatEvent(line)
      if (parsed) onEvent(parsed)
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    emit(splitter.push(value))
  }
  emit(splitter.flush())
}
