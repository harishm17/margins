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
 * that may hold a failure note. It reads like a live failure and offers the same retry.
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
      messages.push({
        kind: 'failure',
        id: message.id,
        message: STORED_FAILURE_TEXT,
        retryable: previous?.kind === 'user',
        question: previous?.kind === 'user' ? previous.text : null,
      })
    }
  }
  return messages
}

/** The markdown source marker for a citation: the pill renderer looks the number up. */
export const sourceByMarker = (sources: readonly ChatSource[], marker: number): ChatSource | undefined =>
  sources.find((source) => source.marker === marker)
