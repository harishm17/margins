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

/** How many of the ideas an answer was graded on it covered whole, and how many only in part. An idea is a concept, which holds several claims. */
export function recallOutcome(feedback: Pick<RecallFeedback, 'got' | 'wrong' | 'missed'>): { total: number; full: number; partly: number } {
  const gotWhole = new Set(feedback.got.filter((item) => !item.partial).map((item) => item.conceptName))
  const gotPart = new Set(feedback.got.filter((item) => item.partial).map((item) => item.conceptName))
  const lacking = new Set([...feedback.wrong, ...feedback.missed].map((item) => item.conceptName))
  const all = new Set([...gotWhole, ...gotPart, ...lacking])
  let full = 0
  let partly = 0
  for (const name of all) {
    const touched = gotWhole.has(name) || gotPart.has(name)
    if (touched && !lacking.has(name) && !gotPart.has(name)) full += 1
    else if (touched) partly += 1
  }
  return { total: all.size, full, partly }
}

/** The one line under an answer, in the same ideas the lists below it are made of. */
export function recallSummary(outcome: { total: number; full: number; partly: number }): string {
  const ideas = `${outcome.total} ${outcome.total === 1 ? 'idea' : 'ideas'}`
  const part = outcome.partly > 0 ? `, and part of ${outcome.partly === 1 ? 'one more' : `${outcome.partly} more`}` : ''
  return `You covered ${outcome.full} of ${ideas}${part}.`
}

/** The items of a list gathered under one idea each, in the order the ideas first appear. */
export function groupByConcept<T extends { conceptName: string }>(items: T[]): { conceptName: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(item.conceptName, [...(groups.get(item.conceptName) ?? []), item])
  return [...groups].map(([conceptName, grouped]) => ({ conceptName, items: grouped }))
}
