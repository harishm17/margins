import { firstTryRecord, hintCostLabel, type HintCost } from '@/lib/learning/help-policy'
import type { LastProblem } from '@/lib/learning/practice-next'
import type { Rung } from '@/lib/learning/practice-evidence'
import { practiceStepKey, type PracticeProgress } from './practice-keys'
import type { PracticeProblem } from './types'

/** What the practice view reads off a problem's steps and the stored progress. `idk`: the I don't know button was pressed. */
export type Feedback = { key: string; kind: 'correct' | 'incorrect' | 'revealed' | 'idk' }

export const stepKeys = (problem: PracticeProblem, problemIndex: number) =>
  problem.steps.map((_step, stepIndex) => practiceStepKey(problemIndex, problem.title, stepIndex))

export function stepStatus(progress: PracticeProgress, key: string): 'solved' | 'revealed' | 'open' {
  if (progress.solved.includes(key)) return 'solved'
  if (progress.revealed.includes(key)) return 'revealed'
  return 'open'
}

export function problemDone(progress: PracticeProgress, problem: PracticeProblem, problemIndex: number): boolean {
  return stepKeys(problem, problemIndex).every((key) => stepStatus(progress, key) !== 'open')
}

export function problemSolved(progress: PracticeProgress, problem: PracticeProblem, problemIndex: number): boolean {
  return stepKeys(problem, problemIndex).every((key) => stepStatus(progress, key) === 'solved')
}

/** What opening a hint costs, in words beside its button (draft copy, spec 18.4). The kinds come from the one help policy. */
export const HINT_COST_COPY: Record<HintCost, string> = {
  still_counts_harder: 'still counts, as a harder try',
  counts_as_miss: 'this step will count as a miss',
  no_extra_cost: 'no extra cost: this step already counts as a miss',
}

export const hintCostCopy = (index: 0 | 1 | 2, state: { attempted: boolean; failedFirstTry: boolean }): string => HINT_COST_COPY[hintCostLabel(index, state)]

/**
 * Whether the step is already a failed first try, so that more help costs nothing more (spec 18.4): an I don't know, help
 * above locate, a second check, a wrong check on a two-option choice. One wrong check with at most locate is still open.
 */
export function stepFailedFirstTry(step: { checks: number; rung: number; dontKnow: boolean; twoOption: boolean }): boolean {
  const record = firstTryRecord({
    checks: step.checks,
    firstCheckCorrect: false,
    solvedOnCheck: null,
    helpRungBeforeSolve: Math.min(5, Math.max(0, step.rung)) as Rung,
    twoOption: step.twoOption,
    dontKnow: step.dontKnow,
    revealed: false,
    workedDelivered: false,
    finished: false,
  })
  return !!record && record.decided && record.assistance === 1
}

/** How the problem just finished went, for `nextPracticeProblem` (spec 18.6). */
export function lastProblemOf(progress: PracticeProgress, problem: PracticeProblem, problemIndex: number): LastProblem {
  const keys = stepKeys(problem, problemIndex)
  const rungs = keys.map((key) => progress.rungs[key] ?? 0)
  return {
    index: problemIndex,
    anyRung3: rungs.some((rung) => rung >= 3),
    idk: keys.some((key) => progress.idk?.includes(key)),
    // Show answer, or the worked example delivered (rung 5).
    surrendered: keys.some((key, i) => progress.revealed.includes(key) || rungs[i] >= 5),
    allFirstTry: keys.length > 0 && keys.every((key, i) => progress.firstTry.includes(key) && progress.solved.includes(key) && rungs[i] === 0),
  }
}
