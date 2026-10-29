/** What the conversation shows, and how stored messages become it. Pure: no React, no network. */
import type { ChatSource, CitationMark, StoredCitations } from '@/lib/chat/citations'

export type UserMessage = { kind: 'user'; id: string; text: string }

export type AssistantMessage = {
  kind: 'assistant'
  id: string
  text: string
  marks: CitationMark[]
  sources: ChatSource[]
  /** Nothing in the materials matched closely, so there was no model call. */
  noSources: boolean
  /** The answer is shown but could not be stored in the conversation. */
  notSaved: boolean
  /** The student stopped the answer early; the stored copy is complete. */
  stopped: boolean
}

export type FailureMessage = {
  kind: 'failure'
  id: string
  message: string
  retryable: boolean
  /** The question to ask again; null for a failure note that came from the database. */
  question: string | null
}

export type ChatMessage = UserMessage | AssistantMessage | FailureMessage

export type StoredMessage = {
  id: string
  role: string
  content: string
  citations: StoredCitations | null
}

/**
 * Failures are no longer stored (the question is removed instead), but conversations from before
 * that may hold a failure note. It reads like a live failure. It offers a retry only when it ends
 * the conversation: a retry is asked at the end of the thread, which is where the server stores
 * it, so an older failure is simply asked again from the box.
 */
export const STORED_FAILURE_TEXT = "This question wasn't answered."

/** The messages of a stored conversation, oldest first. */
export function toChatMessages(stored: readonly StoredMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const message of stored) {
    if (message.role === 'user') {
      messages.push({ kind: 'user', id: message.id, text: message.content })
    } else if (message.role === 'assistant') {
      const sources = message.citations?.sources ?? []
      messages.push({
        kind: 'assistant',
        id: message.id,
        text: message.content,
        marks: message.citations?.marks ?? [],
        sources,
        noSources: sources.length === 0,
        notSaved: false,
        stopped: false,
      })
    } else if (message.role === 'error') {
      const previous = messages[messages.length - 1]
      const last = message === stored[stored.length - 1]
      messages.push({
        kind: 'failure',
        id: message.id,
        message: STORED_FAILURE_TEXT,
        retryable: last && previous?.kind === 'user',
        question: previous?.kind === 'user' ? previous.text : null,
      })
    }
  }
  return messages
}

/** The markdown source marker for a citation: the pill renderer looks the number up. */
export const sourceByMarker = (sources: readonly ChatSource[], marker: number): ChatSource | undefined =>
  sources.find((source) => source.marker === marker)

/**
 * Asking a failed question again. The new try is always added at the end of the conversation (as
 * the server stores it). When the failure is the last thing on screen, it and its question make
 * way for the new try; otherwise nothing on screen is removed. Null when there is nothing to ask.
 */
export function retryPlan(
  messages: readonly ChatMessage[],
  failureId: string
): { question: string; messages: ChatMessage[] } | null {
  const index = messages.findIndex((m) => m.id === failureId)
  const target = messages[index]
  if (!target || target.kind !== 'failure' || !target.question) return null
  if (index !== messages.length - 1) return { question: target.question, messages: [...messages] }
  const before = messages.slice(0, index)
  const last = before[before.length - 1]
  const kept = last?.kind === 'user' && last.text === target.question ? before.slice(0, -1) : before
  return { question: target.question, messages: kept }
}
