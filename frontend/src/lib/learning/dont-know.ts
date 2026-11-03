/**
 * The one "I don't know" contract (spec 18.3). `isDontKnow` is the only test for a typed or spoken IDK, so the
 * tutor, recall, Ask and voice can never disagree about it; `dontKnowEvidence` is the only way one is recorded.
 * Pure.
 */

import type { Assistance, EvidenceSource, ItemAnswerInput } from './evidence-types'

/** Replies that carry no reasoning, lowercased and without punctuation. */
export const LOW_EFFORT: readonly string[] = [
  'idk',
  'i dont know',
  'dont know',
  'no idea',
  'no clue',
  'i dont remember',
  'not sure at all',
  'just tell me',
  'give me the answer',
  'tell me the answer',
  'hint',
  'help',
  '?',
]

/** Lowercase, apostrophes dropped, other punctuation turned to spaces; a run of "?" becomes "?". */
export const normalize = (text: string): string => {
  const trimmed = text.trim().toLowerCase()
  if (/^\?+$/.test(trimmed)) return '?'
  return trimmed
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Politeness, hesitation, intensifier and glue words that pad a request without adding reasoning. */
export const FILLER = new Set([
  'please', 'pls', 'plz', 'thanks', 'thank', 'ok', 'okay', 'so', 'the', 'a', 'an', 'me', 'my', 'can', 'could', 'would',
  'you', 'just', 'answer', 'to', 'for', 'i', 'im', 'is', 'it', 'this', 'that', 'some', 'another', 'next', 'more', 'sorry',
  'hmm', 'hm', 'um', 'uh', 'really', 'honestly', 'actually', 'well', 'lol',
])
/** The words that make up a request for help or an admission of not knowing, once filler is gone. */
export const REQUEST_WORDS = new Set([
  'idk', 'dont', 'know', 'no', 'idea', 'tell', 'give', 'show', 'hint', 'hints', 'help', 'stuck', 'clue', 'solution', 'what', 'how',
  'remember',
])

/** The words that alone make a text an admission or a request ("no", "what", "how" only pad one). */
export const CORE_WORDS = new Set(['idk', 'know', 'idea', 'clue', 'remember', 'stuck', 'hint', 'hints', 'help', 'tell', 'give', 'show', 'solution'])

/**
 * True when nothing is left of the text but filler and admission or request words, however it is padded:
 * "idk", "I don't know", "I don't remember", "no clue lol", "not sure at all", "just tell me please". An empty
 * text is a non-answer too. Anything that says something ("I think it's the mean") is an attempt.
 */
export function isDontKnow(text: string): boolean {
  const normalized = normalize(text)
  if (normalized === '' || LOW_EFFORT.includes(normalized)) return true
  const content = normalized.split(' ').filter((word) => !FILLER.has(word))
  // At least one word must be an admission or a request: a lone filler word ("a", "I", "it") or a lone "no"
  // is an answer on a surface that takes option letters or yes/no, not an admission.
  // "what is the answer" asks for it too, though "what" alone does not.
  const asksForAnswer = /\b(?:answer|solution)\b/.test(normalized) && content.some((word) => word === 'what' || word === 'how')
  return (asksForAnswer || content.some((word) => CORE_WORDS.has(word))) && content.every((word) => REQUEST_WORDS.has(word))
}

/** Where an IDK is given; the evidence source is the surface's own. */
export type DontKnowSurface = Exclude<EvidenceSource, 'implicit' | 'instruction'>

/**
 * The evidence of an IDK: recorded exactly as a wrong answer on that surface would be, with score 0, no
 * confidence (calibration never sees it) and `missKind = 'cue_miss'` (nothing came to mind, spec 6.2.1). It never
 * sets a misconception: any misconception text the caller's metadata carries is dropped.
 *
 * `level` is the surface's: 1 where help then follows on the same item, 0 where none comes mid-session, 2 where
 * the material was just shown.
 */
export function dontKnowEvidence(
  input: Omit<ItemAnswerInput, 'source' | 'score' | 'assistance' | 'confidence' | 'gradedBy'> & { surface: DontKnowSurface; level: 0 | 1 | 2 }
): ItemAnswerInput[] {
  const { surface, level, metadata, ...rest } = input
  const { misconception: _dropped, ...kept } = metadata ?? {}
  return [
    {
      ...rest,
      source: surface,
      score: 0,
      assistance: level as Assistance,
      gradedBy: 'rule',
      metadata: { ...kept, idk: true, missKind: 'cue_miss' },
    },
  ]
}
