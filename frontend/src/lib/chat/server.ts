/** Server-side pieces of the chat routes that do not need a request or a database. */
import { aiServiceHeaders } from '@/lib/ai-service/headers'

export const MAX_QUESTION_CHARS = 2000
export const MAX_THREAD_TITLE_CHARS = 80
/** Earlier messages sent along with a question (three exchanges). */
export const HISTORY_MESSAGES = 6
/** Most the whole answer may take, retrieval included. */
export const CHAT_TIMEOUT_MS = 180_000

export type HistoryMessage = { role: string; content: string }

/** A thread's first question, cut to a title. */
export function titleFromQuestion(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_THREAD_TITLE_CHARS) return flat
  return flat.slice(0, MAX_THREAD_TITLE_CHARS - 1).trimEnd() + '…'
}

/**
 * The turns to send with a question: the last few user and assistant messages, oldest first.
 * Failure notes and anything else in the thread are left out.
 */
export function toHistoryTurns(messages: readonly HistoryMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    .slice(-HISTORY_MESSAGES)
}

export type ChatAnswerRequest = {
  projectId: string
  userId: string
  question: string
  history: { role: 'user' | 'assistant'; content: string }[]
  topicId?: string | null
  /** The conversation, when it already exists: the AI service writes it on the ledger rows of the answer. */
  threadId?: string
  /** Where the thread's tutor state stands (see lib/ask/ask-turn.ts). Absent: the AI service answers at rung 0. */
  tutor?: Record<string, unknown>
}

/** Ask the AI service for a streamed answer. Rejects on network failure or timeout. */
export function requestChatAnswer(request: ChatAnswerRequest, signal?: AbortSignal): Promise<Response> {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000'
  return fetch(`${aiServiceUrl}/chat/answer`, {
    method: 'POST',
    headers: aiServiceHeaders(),
    body: JSON.stringify({
      project_id: request.projectId,
      user_id: request.userId,
      question: request.question,
      history: request.history,
      topic_id: request.topicId ?? null,
      ...(request.threadId ? { thread_id: request.threadId } : {}),
      ...(request.tutor ? { tutor: request.tutor } : {}),
    }),
    signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
  })
}

/** The error code in an AI service error body, or a generic one. */
export async function errorCodeFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown }
    if (typeof body.error_code === 'string') return body.error_code
  } catch {
    // Not JSON: a proxy or crash page.
  }
  // 401/403/5xx without a code: the service itself is not reachable as intended.
  return response.status >= 500 || response.status === 401 || response.status === 403
    ? 'CHAT_UNAVAILABLE'
    : 'CHAT_FAILED'
}
