import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY, practiceStepKey, type PracticeProgress } from './practice-keys'
import { lastProblemOf, stepFailedFirstTry } from './practice-state'
import type { PracticeProblem } from './types'

const problem = (steps: number): PracticeProblem =>
  ({ title: 'P', problem: '', steps: Array.from({ length: steps }, () => ({})), keyConcepts: [], conceptIds: [], difficulty: 'medium', minutes: null, sources: [] }) as unknown as PracticeProblem

const key = (step: number) => practiceStepKey(0, 'P', step)
const progress = (over: Partial<PracticeProgress>): PracticeProgress => ({ ...EMPTY, ...over })

test('a step is a failed first try once its record is decided as one', () => {
  // Nothing checked yet, and one wrong check with at most the locate hint, are still open.
  assert.equal(stepFailedFirstTry({ checks: 0, rung: 0, dontKnow: false, twoOption: false }), false)
  assert.equal(stepFailedFirstTry({ checks: 1, rung: 0, dontKnow: false, twoOption: false }), false)
  assert.equal(stepFailedFirstTry({ checks: 1, rung: 1, dontKnow: false, twoOption: false }), false)
  // An I don't know, Connect or deeper, a second wrong check, and a wrong check on a two-option choice are decided.
  assert.equal(stepFailedFirstTry({ checks: 1, rung: 0, dontKnow: true, twoOption: false }), true)
  assert.equal(stepFailedFirstTry({ checks: 1, rung: 3, dontKnow: false, twoOption: false }), true)
  assert.equal(stepFailedFirstTry({ checks: 2, rung: 0, dontKnow: false, twoOption: false }), true)
  assert.equal(stepFailedFirstTry({ checks: 1, rung: 0, dontKnow: false, twoOption: true }), true)
})

test('the problem just finished is read from the progress for the next-problem choice', () => {
  const p = problem(3)
  const clean = progress({ solved: [key(0), key(1), key(2)], attempted: [key(0), key(1), key(2)], firstTry: [key(0), key(1), key(2)] })
  assert.deepEqual(lastProblemOf(clean, p, 0), { index: 0, anyRung3: false, idk: false, surrendered: false, allFirstTry: true })
  // A locate hint is not rung 3, but it is not a clean sweep either.
  assert.deepEqual(lastProblemOf({ ...clean, rungs: { [key(1)]: 1 } }, p, 0), { index: 0, anyRung3: false, idk: false, surrendered: false, allFirstTry: false })
  const helped = progress({ solved: [key(0), key(1)], revealed: [key(2)], attempted: [key(0), key(1), key(2)], firstTry: [key(0)], rungs: { [key(1)]: 3 }, idk: [key(1)] })
  assert.deepEqual(lastProblemOf(helped, p, 0), { index: 0, anyRung3: true, idk: true, surrendered: true, allFirstTry: false })
  // A step solved after the worked example (rung 5) is a surrender too.
  const worked = progress({ solved: [key(0), key(1), key(2)], attempted: [key(0), key(1), key(2)], rungs: { [key(2)]: 5 } })
  assert.deepEqual(lastProblemOf(worked, p, 0), { index: 0, anyRung3: true, idk: false, surrendered: true, allFirstTry: false })
})
