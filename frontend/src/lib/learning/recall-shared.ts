/** What the Recall step's server code (recall-server.ts) and its screen (features/topic/recall-view.tsx) share. No server imports. */

import type { HelpAfterMiss } from './instruction-server'

export const MAX_RECALL_ANSWER_CHARS = 5000

export type RevealedClaim = { claimId: string; conceptName: string; text: string; quote: string; page: number | null }

/** What the student reads after a graded answer: their own words first, the source's words only for what is wrong. */
export type RecallFeedback = {
  attemptId: string
  /** What the student wrote (empty for "I don't remember" before it was stored), so the feedback can show their own words first. */
  answer: string
  /** The reader or explainer was opened while the card was open: the answer does not count toward the score. */
  abandoned: boolean
  /** A second try the same day after seeing feedback (`seen`) or after the missed claims were shown (`revealed`): assisted too. */
  repeat: 'seen' | 'revealed' | null
  got: { conceptName: string; quote: string; partial: boolean }[]
  wrong: { conceptName: string; studentQuote: string; misconception: string; sourceQuote: string; page: number | null }[]
  missed: { claimId: string; conceptName: string; pointer: string }[]
  /** The missed claims, once the student asked to see them. */
  revealed: RevealedClaim[] | null
  /** The answer was "I don't remember" (the button, or a typed admission): nothing was graded. */
  idk: boolean
  /** Where to look, for an answer with gaps (spec 18.3): a link per missed idea, the explainer, an easier step. Null when nothing was missed. */
  help: HelpAfterMiss | null
}

export type RecallCard = {
  /** `o2`, `all`, `tb:<conceptId>` or `tb`: how the browser and the attempts know the card. */
  key: string
  kind: 'recall' | 'teach_back'
  objectiveIndex: number | null
  conceptId: string | null
  prompt: string
  /** The newest graded attempt at this card, if there is one. */
  latest: RecallFeedback | null
}

export type RecallState = { mode: 'recall' | 'teach_back'; cards: RecallCard[] }
