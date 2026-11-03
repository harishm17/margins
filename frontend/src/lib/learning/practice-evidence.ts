/**
 * Practice steps as evidence (spec §3.3, §5.6, §6.2): the rung ladder, the level each rung records,
 * the score of a finished step, and the checks that keep a stored practice record consistent.
 * Pure functions. The answer keys stay in the browser (D14), so the server cannot verify that an
 * answer was right; it can only reject transitions that cannot have happened.
 */

import type { Assistance, ItemAnswerInput } from './evidence-types'
import { SECOND_CHECK_SCORE, firstTryRecord } from './help-policy'
import { itemKey } from './item-key'

/** The tutor ladder (spec §6.2): 0 orient, 1 locate, 2 narrow, 3 name, 4 structure, 5 worked analogue. */
export type Rung = 0 | 1 | 2 | 3 | 4 | 5

/** The rungs of the three authored hints: locate, connect, structure. The tutor tasks import this. */
export const AUTHORED_HINT_RUNG: readonly [1, 3, 4] = [1, 3, 4]

/**
 * What a success is recorded as after help up to this rung, and the most the score can then be (spec 18.4): no help
 * is a first-try success, the locate hint (rung 1) caps it at 0.6, and anything above it is a failed first try
 * (level 1, score 0). The cost labels read this; the record itself is `firstTryRecord`.
 */
export function assistanceFromRung(maxRung: Rung): { assistance: 0 | 1; scoreCap: number } {
  if (maxRung <= 0) return { assistance: 0, scoreCap: 1 }
  if (maxRung === 1) return { assistance: 0, scoreCap: SECOND_CHECK_SCORE }
  return { assistance: 1, scoreCap: 0 }
}

/** The worked analogue: only the student's "Show me a worked example" button reaches it, and a delivered one surrenders the item. */
export const WORKED_RUNG: Rung = 5

/** The indexes (0 locate, 1 connect, 2 structure) of a step's hints that have text. Content from before rungs has only the connect hint. */
export const availableHints = (hints: readonly string[]): number[] =>
  AUTHORED_HINT_RUNG.map((_rung, index) => index).filter((index) => !!hints[index]?.trim())

/**
 * The evidence of one finished step, or null while it is open or never checked: `firstTryRecord` (spec 18.4), one
 * record per item. A first-try success scores 1 (0.6 after the locate hint); a success on the second check scores
 * 0.6 on an item that is not a two-option choice; anything else, and every IDK, shown answer and delivered worked
 * example, is a failed first try (level 1, score 0).
 *
 * Callers that hold the server's record of the step pass `checks`, `solvedOnCheck`, `twoOption`, `dontKnow` and
 * `workedDelivered`. A caller that holds only the stored progress (the backfill) leaves them out: a solved step
 * that was not right at once is then taken to have been solved on its second check, and rung 5 as a delivered
 * worked example. A locate hint after a miss scores the same 0.6 as one before it.
 */
export function practiceStepEvidence(step: {
  firstTryCorrect: boolean
  attempted: boolean
  maxRung: Rung
  revealed: boolean
  solved: boolean
  /** Legacy: the step was surrendered (rung 5 from a browser that predates delivery). */
  surrendered?: boolean
  checks?: number
  solvedOnCheck?: number | null
  twoOption?: boolean
  dontKnow?: boolean
  workedDelivered?: boolean
}): { score: number; assistance: Assistance } | null {
  const solvedOnCheck = step.solvedOnCheck !== undefined ? step.solvedOnCheck : step.solved ? (step.firstTryCorrect ? 1 : 2) : null
  const checks = step.checks ?? (step.attempted || step.dontKnow || step.revealed ? Math.max(1, solvedOnCheck ?? 1) : 0)
  const record = firstTryRecord({
    checks,
    firstCheckCorrect: step.firstTryCorrect,
    solvedOnCheck,
    helpRungBeforeSolve: step.maxRung,
    twoOption: step.twoOption ?? false,
    dontKnow: step.dontKnow ?? false,
    revealed: step.revealed && !step.solved,
    workedDelivered: step.workedDelivered ?? (step.surrendered === true || step.maxRung >= WORKED_RUNG),
    finished: step.solved || step.revealed,
  })
  // A step still open (one wrong check, nothing else) has no evidence until it finishes.
  if (!record || (!record.decided && !step.solved && !step.revealed)) return null
  return { score: record.score, assistance: record.assistance }
}

/** The key of one tutor conversation: this step of this problem of this practice (spec §6.2). */
export const practiceScopeKey = (contentId: string, problemIndex: number, stepIndex: number) => `${contentId}:${problemIndex}:${stepIndex}`

/** One problem's stored state, by step position (0-based). `maxRungs` is step -> highest rung used. */
export type PracticeState = {
  solvedSteps: number[]
  revealedSteps: number[]
  attemptedSteps: number[]
  firstTrySteps: number[]
  maxRungs: Record<number, number>
  /** Step -> the rung the student had reached at the first wrong check of that step. */
  missRungs: Record<number, number>
}

export type PracticeValidation = { ok: true } | { ok: false; reason: string }

/** The first rung that needs an attempt on the step (Connect); locate (rung 1) is open from the start. */
const GATED_RUNG = 3

/**
 * Rejects a stored state that cannot follow the previous one. `prev` is null for a problem with no
 * row. An empty state is "Start over" and always accepted. The hint gate (spec 18.4) holds here too: a rung
 * of 3 or more (Connect, Structure, the worked example) and a shown answer need an attempt on the step, a
 * checked answer or "I don't know". Opening every hint no longer stands in for one.
 */
export function validatePracticeProgress(prev: PracticeState | null, next: PracticeState): PracticeValidation {
  const fail = (reason: string): PracticeValidation => ({ ok: false, reason })
  const rungOf = (state: PracticeState, step: number) => state.maxRungs[step] ?? 0
  const nextAttempted = new Set(next.attemptedSteps)
  const nextSolved = new Set(next.solvedSteps)
  const nextRevealed = new Set(next.revealedSteps)

  for (const [step, rung] of Object.entries(next.maxRungs)) {
    if (rung >= GATED_RUNG && !nextAttempted.has(Number(step))) return fail('Help beyond the first hint needs an attempt on the step.')
  }
  for (const rungs of [next.maxRungs, next.missRungs]) {
    for (const [step, rung] of Object.entries(rungs)) {
      if (!Number.isInteger(Number(step)) || !Number.isInteger(rung) || rung < 0 || rung > 5) return fail('A rung is out of range.')
    }
  }

  const isReset =
    next.solvedSteps.length === 0 &&
    next.revealedSteps.length === 0 &&
    next.attemptedSteps.length === 0 &&
    next.firstTrySteps.length === 0 &&
    Object.keys(next.maxRungs).length === 0 &&
    Object.keys(next.missRungs).length === 0
  if (isReset) return { ok: true }

  const before = prev ?? { solvedSteps: [], revealedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} }
  const beforeSolved = new Set(before.solvedSteps)
  const beforeRevealed = new Set(before.revealedSteps)
  const beforeAttempted = new Set(before.attemptedSteps)
  const beforeFirstTry = new Set(before.firstTrySteps)

  for (const step of beforeSolved) if (!nextSolved.has(step)) return fail('A solved step cannot become unsolved.')
  for (const step of beforeRevealed) if (!nextRevealed.has(step) && !nextSolved.has(step)) return fail('A shown answer cannot be taken back.')
  for (const step of beforeAttempted) if (!nextAttempted.has(step)) return fail('A checked attempt cannot be taken back.')
  for (const [step, rung] of Object.entries(before.maxRungs)) {
    if ((next.maxRungs[Number(step)] ?? 0) < rung) return fail('A rung cannot go down.')
  }
  for (const [step, rung] of Object.entries(before.missRungs)) {
    if (next.missRungs[Number(step)] !== rung) return fail('A recorded miss cannot be changed.')
  }
  for (const step of beforeFirstTry) if (!next.firstTrySteps.includes(step)) return fail('A first-try success cannot be taken back.')

  for (const step of next.firstTrySteps) {
    if (!nextSolved.has(step)) return fail('A first-try success must be a solved step.')
    if (!beforeFirstTry.has(step) && beforeAttempted.has(step)) return fail('A step checked before cannot be a first-try success.')
  }
  for (const [step, rung] of Object.entries(next.missRungs)) {
    const index = Number(step)
    if (!nextAttempted.has(index)) return fail('A miss needs a checked attempt.')
    if (next.firstTrySteps.includes(index)) return fail('A first-try success cannot have a miss.')
    if (rung > rungOf(next, index)) return fail('A miss cannot be at a higher rung than the step reached.')
  }
  for (const step of next.solvedSteps) {
    if (!beforeSolved.has(step) && !beforeRevealed.has(step) && !nextAttempted.has(step)) return fail('A step was solved without a checked attempt.')
  }
  for (const step of next.revealedSteps) {
    if (beforeRevealed.has(step) || beforeSolved.has(step)) continue
    if (!nextAttempted.has(step)) return fail('The answer was shown before an attempt.')
  }
  return { ok: true }
}

const asRung = (value: number | undefined): Rung => (value !== undefined && value >= 0 && value <= 5 ? (value as Rung) : 0)

/**
 * The evidence for the steps of one problem that finished with this save (spec §5.6, §18.4): one first-try
 * record per step (`practiceStepEvidence`). Steps without concepts write nothing. `detail` gives, per step, what
 * the server knows beyond the stored progress (its checks, the check it was solved on, an IDK, a delivered
 * worked example); the backfill passes none.
 */
export function buildPracticeEvidence(input: {
  userId: string
  projectId: string
  topicId: string
  contentId: string
  problemIndex: number
  /** Step position -> the concept ids it practises (active ones only). */
  conceptIdsOf: (step: number) => string[]
  newlyFinished: number[]
  next: PracticeState
  detail?: (step: number) => Partial<Pick<Parameters<typeof practiceStepEvidence>[0], 'checks' | 'solvedOnCheck' | 'twoOption' | 'dontKnow' | 'workedDelivered'>>
  sessionKey: string
  at?: Date
}): ItemAnswerInput[] {
  const solved = new Set(input.next.solvedSteps)
  const attempted = new Set(input.next.attemptedSteps)
  const firstTry = new Set(input.next.firstTrySteps)
  const inputs: ItemAnswerInput[] = []
  for (const step of input.newlyFinished) {
    const conceptIds = input.conceptIdsOf(step)
    if (conceptIds.length === 0) continue
    const maxRung = asRung(input.next.maxRungs[step])
    const detail = input.detail?.(step) ?? {}
    const evidence = practiceStepEvidence({
      firstTryCorrect: firstTry.has(step),
      attempted: attempted.has(step),
      maxRung,
      revealed: !solved.has(step),
      solved: solved.has(step),
      ...detail,
    })
    if (!evidence) continue
    const base = {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      itemKey: itemKey({ kind: 'practice', contentId: input.contentId, problem: input.problemIndex, step }),
      conceptIds,
      source: 'practice' as const,
      gradedBy: 'rule' as const,
      sessionKey: input.sessionKey,
      at: input.at,
    }
    const surrendered = detail.workedDelivered ?? maxRung >= WORKED_RUNG
    // An IDK is recorded as the wrong answer it is: no confidence, a cue miss, no misconception (spec 18.3).
    inputs.push({
      ...base,
      ...evidence,
      metadata: { maxRung, ...(surrendered ? { surrendered: true } : {}), ...(detail.dontKnow ? { idk: true, missKind: 'cue_miss' } : {}) },
    })
  }
  return inputs
}

/**
 * The evidence written the moment the student asks for the worked example (spec §6.2): level 3, so the
 * concept's next review is pulled to tomorrow, and flagged `surrendered` so the closing retest of a
 * review session (§7.4) can find the item and serve it again in a fresh form. `metadata` names the
 * item (`contentId`, `problemIndex`, `step`; the item key is on the event) for that. The problem stays
 * open; when the step is finished later its own evidence follows (buildPracticeEvidence). Null for a
 * step without concepts.
 */
export function buildSurrenderEvidence(input: {
  userId: string
  projectId: string
  topicId: string
  contentId: string
  problemIndex: number
  step: number
  conceptIds: string[]
  sessionKey: string
  at?: Date
}): ItemAnswerInput | null {
  if (input.conceptIds.length === 0) return null
  return {
    userId: input.userId,
    projectId: input.projectId,
    topicId: input.topicId,
    itemKey: itemKey({ kind: 'practice', contentId: input.contentId, problem: input.problemIndex, step: input.step }),
    conceptIds: input.conceptIds,
    source: 'practice',
    score: 0,
    assistance: 3,
    gradedBy: 'rule',
    sessionKey: input.sessionKey,
    at: input.at,
    metadata: { maxRung: WORKED_RUNG, surrendered: true, contentId: input.contentId, problemIndex: input.problemIndex, step: input.step },
  }
}
