/**
 * The one help-after-attempt scoring policy (spec 18.4). Every answerable item yields exactly one first-try
 * record, decided from the server's own record of the item. Pure: practice reads it from the `TutorState` of the
 * step; nothing here depends on how the help was asked for, only on what happened.
 *
 * The incentive never inverts. Trying first is never scored below asking first or giving up:
 * - Connect, Structure, the worked example and Show answer open only after an attempt (`canOpenHint`), so help
 *   above rung 1 before an attempt does not exist;
 * - locate (rung 1) before or after a miss gives the same 0.6;
 * - once a step is a failed first try, more help costs nothing more.
 */

import type { Rung } from './practice-evidence'

/** The score of a success on the second check (and of a success after a locate hint): Hard under spec 3.5. */
export const SECOND_CHECK_SCORE = 0.6

/** What the server knows about one practice step. */
export type FirstTryStep = {
  /** Checks made, a wrong or right answer or an IDK (an IDK is the first check, wrong). */
  checks: number
  firstCheckCorrect: boolean
  /** The 1-based check that was right, or null while the step is unsolved. */
  solvedOnCheck: number | null
  /** The highest rung given before the step was solved (or before it was left). */
  helpRungBeforeSolve: Rung
  /** A two-option choice (true/false): a second check is a coin flip, not a retrieval. */
  twoOption: boolean
  dontKnow: boolean
  /** Show answer was used. */
  revealed: boolean
  /** The worked analogue was actually delivered (a leak-judge fallback to an authored hint is not). */
  workedDelivered: boolean
  /** The step is over (solved, shown, or left behind), so nothing later can change the record. */
  finished: boolean
}

export type FirstTryRecord = {
  /** 0 a first-try success, 1 a failed first try. */
  assistance: 0 | 1
  score: number
  /** True when no later action can change the record, so it is written now (spec 18.4, "When the record is written"). */
  decided: boolean
}

/**
 * The step's first-try record, or null when it was never checked (opening a hint is not an attempt; interrupting
 * costs nothing).
 *
 * | What happened | Level | Score |
 * |---|---|---|
 * | Right on the first check, no help | 0 | 1.0 |
 * | Right on the first check after locate only | 0 | 0.6 |
 * | Right on the second check, locate at most, not a two-option item | 0 | 0.6 |
 * | Anything else that ends right (third check, second check on two options, help above locate) | 1 | 0 |
 * | Wrong and not finished, IDK, Show answer, a delivered worked example | 1 | 0 |
 */
export function firstTryRecord(step: FirstTryStep): FirstTryRecord | null {
  if (step.checks < 1 && !step.dontKnow) return null
  const failed = (decided: boolean): FirstTryRecord => ({ assistance: 1, score: 0, decided })

  // An IDK, the answer shown or a delivered worked example fail the first try for good, whatever follows.
  if (step.dontKnow || step.revealed || step.workedDelivered) return failed(true)
  // Rung 2 and above gives away the retrieval itself, so the first try failed.
  if (step.helpRungBeforeSolve > 1) return failed(true)

  const solvedOn = step.solvedOnCheck ?? (step.firstCheckCorrect ? 1 : null)
  if (solvedOn !== null) {
    const located = step.helpRungBeforeSolve === 1
    if (solvedOn === 1) return { assistance: 0, score: located ? SECOND_CHECK_SCORE : 1, decided: true }
    if (solvedOn === 2 && !step.twoOption) return { assistance: 0, score: SECOND_CHECK_SCORE, decided: true }
    return failed(true)
  }

  // Wrong so far. One wrong check is still open on a free-text item: a success on the second check gives 0.6, so
  // the record waits for the step to finish. A second wrong check, or a wrong check on a two-option choice (whose
  // second check cannot score), leaves nothing that could raise it.
  return failed(step.finished || step.checks >= 2 || step.twoOption)
}

/** Whether hint `index` (0 locate, 1 connect, 2 structure) may be opened: locate always, the others after an attempt. */
export function canOpenHint(index: 0 | 1 | 2, attempted: boolean): boolean {
  return index === 0 || attempted
}

export type HintCost = 'still_counts_harder' | 'counts_as_miss' | 'no_extra_cost'

/**
 * What opening this hint costs, for the label beside its button (the UI maps each result to copy):
 * - `no_extra_cost`: the step is already a failed first try, so more help is free;
 * - `still_counts_harder`: locate on a step that is not yet a miss (the score is capped at 0.6);
 * - `counts_as_miss`: Connect or Structure, which make the step a failed first try.
 */
export function hintCostLabel(index: 0 | 1 | 2, state: { attempted: boolean; failedFirstTry: boolean }): HintCost {
  if (state.failedFirstTry) return 'no_extra_cost'
  return index === 0 ? 'still_counts_harder' : 'counts_as_miss'
}
