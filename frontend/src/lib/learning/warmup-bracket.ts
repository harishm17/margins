// The bracketed warm-up (spec §5.1). The bank holds five questions tagged easy, medium or hard and the student
// answers three: the first is medium; a confident right answer (Fairly sure or higher) moves the next one up,
// a wrong answer or a guess moves it down. Pure; the session code in warmup-session.ts calls it.

import { isConfidenceId, type ConfidenceId } from './calibration'

export type WarmupDifficulty = 'easy' | 'medium' | 'hard'

const LEVELS: WarmupDifficulty[] = ['easy', 'medium', 'hard']

/** How many questions the student answers. */
export const WARMUP_LENGTH = 3
/** Confident enough to move up, and for the test-out offer (Fairly sure stores 0.75). */
export const SURE_CONFIDENCE = 0.75
/** A stored value at or under this, with no level kept beside it, was a guess. */
const GUESS_CONFIDENCE = 0.25

type Confidence = { confidence?: number; confidenceLevel?: ConfidenceId | string }

/** What one answer told the bracket. */
export type WarmupAnswer = { difficulty: WarmupDifficulty; correct: boolean } & Confidence

/** One answered question as the reader and the results read it: the concepts it tested and how it went. */
export type WarmupResult = { conceptIds: string[]; correct: boolean } & Confidence

const guessed = (answer: Confidence) =>
  answer.confidenceLevel === 'guess' || (!isConfidenceId(answer.confidenceLevel) && answer.confidence !== undefined && answer.confidence <= GUESS_CONFIDENCE)

const sure = (answer: Confidence) =>
  answer.confidenceLevel === 'fairly' ||
  answer.confidenceLevel === 'certain' ||
  (!isConfidenceId(answer.confidenceLevel) && answer.confidence !== undefined && answer.confidence >= SURE_CONFIDENCE)

/**
 * Right, and with confidence of Fairly sure or higher. Only this counts towards the test-out offer: a right answer
 * marked Guessing, or one the student was unsure of, is not evidence they know it (spec 5.1).
 */
export function sureCorrect(result: WarmupResult): boolean {
  return result.correct && sure(result)
}

/**
 * Right and not a guess. The fade start level and the band's prior count this: a right answer marked Guessing counts
 * as wrong (spec 5.1), but one the student was merely unsure of still shows some knowledge.
 */
export function knownCorrect(result: WarmupResult): boolean {
  return result.correct && !guessed(result)
}

/**
 * The warm-up score of each concept the questions tested, for the band's `prior` (spec 18.6): the mean over the
 * questions that tested it, each 1 when `knownCorrect` and 0 otherwise (a miss, an "I don't know", a guess).
 */
export function warmupPriorByConcept(results: WarmupResult[]): Map<string, number> {
  const totals = new Map<string, { sum: number; n: number }>()
  for (const result of results) {
    for (const conceptId of result.conceptIds) {
      const at = totals.get(conceptId) ?? { sum: 0, n: 0 }
      totals.set(conceptId, { sum: at.sum + (knownCorrect(result) ? 1 : 0), n: at.n + 1 })
    }
  }
  return new Map([...totals].map(([conceptId, { sum, n }]) => [conceptId, sum / n]))
}

/**
 * The level of the next question: medium first; one level up after a right answer the student was sure of, one
 * down after a wrong answer or a guess (a lucky guess says nothing about the level), the same level otherwise.
 */
export function nextWarmupDifficulty(prev: WarmupAnswer | null): WarmupDifficulty {
  if (!prev) return 'medium'
  const at = LEVELS.indexOf(prev.difficulty)
  if (!prev.correct || guessed(prev)) return LEVELS[Math.max(0, at - 1)]
  if (sure(prev)) return LEVELS[Math.min(LEVELS.length - 1, at + 1)]
  return prev.difficulty
}

/**
 * The bank item to serve for a level: the first one not asked yet at that level, else the nearest level that
 * has one (the easier of two equally near). Null when every item has been asked.
 */
export function pickWarmupItem(bank: { index: number; difficulty: WarmupDifficulty }[], asked: number[], wanted: WarmupDifficulty): number | null {
  const left = bank.filter((item) => !asked.includes(item.index))
  const distance = (item: { difficulty: WarmupDifficulty }) => Math.abs(LEVELS.indexOf(item.difficulty) - LEVELS.indexOf(wanted))
  let best: { index: number; difficulty: WarmupDifficulty } | null = null
  for (const item of left) {
    if (!best || distance(item) < distance(best) || (distance(item) === distance(best) && LEVELS.indexOf(item.difficulty) < LEVELS.indexOf(best.difficulty))) best = item
  }
  return best ? best.index : null
}

/**
 * The chunks to mark "Focus here": the chunk of every claim of a concept the warm-up missed or the student
 * guessed, in claim order. Nothing is hidden: the reader shows all of it and only marks these.
 */
export function focusChunks(results: WarmupResult[], claims: { conceptId: string; chunkId: string | null }[]): string[] {
  const weak = new Set(results.filter((result) => !result.correct || guessed(result)).flatMap((result) => result.conceptIds))
  const chunks: string[] = []
  for (const claim of claims) {
    if (claim.chunkId && weak.has(claim.conceptId) && !chunks.includes(claim.chunkId)) chunks.push(claim.chunkId)
  }
  return chunks
}

/** Every answer right and given with confidence of Fairly sure or higher: "You may know this already". */
export function offersTestOut(results: WarmupResult[]): boolean {
  return results.length > 0 && results.every(sureCorrect)
}
