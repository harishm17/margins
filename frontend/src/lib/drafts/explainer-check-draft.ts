// The server draft of an explainer "Check yourself" block (spec §18.7, surface explainer_check): its key and its payload.
// No database or React imports.

import { parseDraftKey } from './draft-contract'

export type ExplainerCheckDraft = { answer: string }

/** A short stable hash of the question, so a block keeps its draft when the page is shown again. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (const ch of text.trim().replace(/\s+/g, ' ')) {
    h ^= ch.codePointAt(0) as number
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * The scope key `<topicId>:<blockId>`. The block id names where the explainer put the block (`scope`: the notes, or one
 * gap's explanation) and the question, so two blocks on a page never share a draft. Null when the parts do not make a valid key.
 */
export function explainerCheckKey(topicId: string, scope: string, question: string): string | null {
  const safe = scope.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60)
  const key = `${topicId}:${safe}-${hash(question)}`
  return parseDraftKey('explainer_check', key) ? key : null
}

export function parseExplainerCheckDraft(raw: unknown): ExplainerCheckDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const answer = (raw as Record<string, unknown>).answer
  return typeof answer === 'string' && answer !== '' ? { answer } : null
}
