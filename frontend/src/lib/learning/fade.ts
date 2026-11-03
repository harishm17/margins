// Faded worked examples on three levels (spec 5.5, 18.6). The less a student already knows, the more of each example is
// worked for them; support is added quickly and removed slowly, because self-grades run optimistic (Dunlosky & Rawson
// 2012). Pure: the screen reads the level and the hidden steps from here.

import type { CheckGrade } from '@/lib/reader/checks'
import type { Band } from './level'
import { knownCorrect, type WarmupResult } from './warmup-bracket'

/**
 * - `full`: every step shown, each step's "why" behind a guess;
 * - `partial`: the last step hidden (the last two from the third example);
 * - `problem_first`: only the problem, steps revealed one at a time after a written move.
 */
export type FadeLevel = 'full' | 'partial' | 'problem_first'

const LEVELS: FadeLevel[] = ['full', 'partial', 'problem_first']

/** The third example and later hide this many of the last steps at `partial`. */
const LATE_HIDDEN = 2

/** The first example's level, from the topic band: band 0 full, band 1 partial, band 2 problem first. */
export function fadeStart(band: Band): FadeLevel {
  return LEVELS[band]
}

/**
 * The level of the example after `previousGrades.length` examples, starting from `start`. Each example moves the level
 * at most one step, using the self-grades of the hidden parts of the example just seen (and the one before it):
 * - any Missed (an "I don't know" is graded Missed) moves one level towards `full`;
 * - every part Got it on each of the previous two examples moves one level towards `problem_first`;
 * - otherwise it stays. A Partly, or an example with nothing hidden, changes nothing.
 */
export function fadeFor(start: FadeLevel, previousGrades: CheckGrade[][]): FadeLevel {
  let at = LEVELS.indexOf(start)
  const allGotIt = (grades: CheckGrade[] | undefined) => !!grades && grades.length > 0 && grades.every((g) => g === 'got_it')
  for (let k = 1; k <= previousGrades.length; k += 1) {
    const last = previousGrades[k - 1]
    if (last.includes('missed')) at = Math.max(0, at - 1)
    else if (k >= 2 && allGotIt(last) && allGotIt(previousGrades[k - 2])) at = Math.min(LEVELS.length - 1, at + 1)
  }
  return LEVELS[at]
}

/**
 * The share of warm-up answers that were right and not guesses; null without a finished warm-up. A right answer marked
 * Guessing counts as wrong: luck says nothing about what the student knows (spec 5.1).
 */
export function warmupScoreOf(results: WarmupResult[] | null): number | null {
  if (!results || results.length === 0) return null
  return results.filter(knownCorrect).length / results.length
}

/** Whether each step's "why" waits for the student's guess: at `full`, on every example. */
export function hidesWhy(level: FadeLevel, _exampleIndex: number): boolean {
  return level === 'full'
}

/**
 * The steps (0-based) the student predicts before they show. `full`: none. `partial`: the last, and the last two from
 * the third example on. `problem_first`: every step.
 */
export function hiddenSteps(level: FadeLevel, exampleIndex: number, stepCount: number): number[] {
  const all = Array.from({ length: Math.max(0, stepCount) }, (_, index) => index)
  if (level === 'problem_first') return all
  if (level === 'full') return []
  return all.slice(-(exampleIndex >= 2 ? LATE_HIDDEN : 1))
}
