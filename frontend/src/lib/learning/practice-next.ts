/**
 * The next practice problem (spec 18.6): support follows how the problem just finished went. Pure.
 *
 * - After a problem with any step at rung 3 or higher, an "I don't know" or a surrender, the first unfinished problem of
 *   lower difficulty comes next; when there is none, the next in order, with one worked through offered first.
 * - After a problem where every step was right first time, the first unfinished problem of higher difficulty.
 * - Otherwise the next unfinished problem in order.
 */

export type PracticeDifficulty = 'easy' | 'medium' | 'hard'

export type PracticeProblemState = { difficulty: string | null; finished: boolean }

export type LastProblem = {
  /** Position of the problem that was just finished. */
  index: number
  /** Any step needed the Connect hint or more. */
  anyRung3: boolean
  idk: boolean
  surrendered: boolean
  /** Every step was right on the first check with no help. */
  allFirstTry: boolean
}

export type NextProblem = {
  /** The problem to go to, or null when every problem is finished. */
  index: number | null
  /** "See one worked through first": the support for a problem that went badly has nowhere easier to go. */
  offerExample: boolean
}

const RANK: Record<PracticeDifficulty, number> = { easy: 0, medium: 1, hard: 2 }

/** A problem with no stated difficulty, or one this does not know, is a medium one. */
export const difficultyRank = (difficulty: string | null): number => RANK[(difficulty as PracticeDifficulty | null) ?? 'medium'] ?? RANK.medium

export function nextPracticeProblem(problems: PracticeProblemState[], last: LastProblem): NextProblem {
  const open = problems.map((problem, index) => ({ problem, index })).filter(({ problem, index }) => !problem.finished && index !== last.index)
  const here = difficultyRank(problems[last.index]?.difficulty ?? null)
  // After the last problem it wraps to the first one still open.
  const inOrder = open.find(({ index }) => index > last.index) ?? open[0]
  const struggled = last.anyRung3 || last.idk || last.surrendered
  if (struggled) {
    const easier = open.find(({ problem }) => difficultyRank(problem.difficulty) < here)
    if (easier) return { index: easier.index, offerExample: false }
    return { index: inOrder?.index ?? null, offerExample: true }
  }
  if (last.allFirstTry) {
    const harder = open.find(({ problem }) => difficultyRank(problem.difficulty) > here)
    if (harder) return { index: harder.index, offerExample: false }
  }
  return { index: inOrder?.index ?? null, offerExample: false }
}
