/** What a review or drill session shows the browser (spec §7.4). Types only, so client code can import them. */

import type { PublicQuizQuestion } from './quiz-questions'
import type { QuizReviewItem } from './quiz-review'
import type { HelpAfterMiss } from './instruction-server'

export type SessionKind = 'review' | 'drill'

/** Where an item sits in the session: the warm opening, the interleaved body, a closing retest, a drill item. */
export type SessionPhase = 'opening' | 'body' | 'retest' | 'drill' | 'prerequisite'

export type PublicSessionItem = {
  index: number
  phase: SessionPhase
  topicId: string
  topicName: string
  conceptNames: string[]
  question: PublicQuizQuestion
}

/** An answered item: what the student gave and the result, with the answer key released. */
export type PublicAnswered = {
  answer: string
  /** The student pressed "I don't know" (spec 18.3): a miss with nothing to grade. */
  idk?: boolean
  /** Where to look for a missed item: the first claim of each concept it tests (spec 18.5). Only on a miss. */
  pointers?: HelpAfterMiss['pointers']
  confidence?: number
  thinking?: string
  correct: boolean
  review: QuizReviewItem
}

export type SessionSummary = {
  total: number
  correct: number
  /** Closing retests answered, and how many were right. */
  retests: { total: number; correct: number }
  /** Concepts that were missed and then retested right, and those still not right. */
  recovered: string[]
  stillShaky: string[]
  /** Missed concepts that got no fresh question to retest (none could be written). Always empty for a drill. */
  notRetested: string[]
  /** What to look at for the missed concepts: pointers, the explainer and an easier step (spec 18.5). Null when nothing was missed. */
  helpAfterMiss: HelpAfterMiss | null
}

export type SessionStatus = 'preparing' | 'active' | 'complete' | 'failed'

export type SessionView = {
  id: string
  kind: SessionKind
  status: SessionStatus
  /** "Today's review", the topic's name or the concept's name. */
  title: string
  items: PublicSessionItem[]
  answered: Record<string, PublicAnswered>
  /** Index of the first item not yet answered, or null when every item has been. */
  next: number | null
  /** Text for a failed session or a notice (a retest that could not be written). */
  message: string | null
  summary: SessionSummary | null
  /** Misses so far that will come back once at the end in a fresh form and are not served yet ("Question 6 of 12 (+2 to retest)"). */
  retestsToCome: number
  /** A short session (the 10-minute session, spec 18.8). */
  short: boolean
  /** The session ends with a fresh retest of each miss: a review without a retest cap of zero. A drill has none. */
  closingRetests: boolean
}

export const firstUnanswered = (itemCount: number, answered: Record<string, unknown>): number | null => {
  for (let i = 0; i < itemCount; i++) if (!answered[String(i)]) return i
  return null
}
