import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPracticeProblem } from './practice-next'

type Problem = { difficulty: 'easy' | 'medium' | 'hard' | null; finished: boolean }
const set = (...levels: Problem['difficulty'][]): Problem[] => levels.map((difficulty) => ({ difficulty, finished: false }))
const clean = { anyRung3: false, idk: false, surrendered: false, allFirstTry: false }
const finishing = (problems: Problem[], ...indexes: number[]) => problems.map((p, i) => (indexes.includes(i) ? { ...p, finished: true } : p))

test('easier problem after rung 3', () => {
  // Problem 1 (medium) needed the Connect hint: the first unfinished easier one comes next, though a medium one is closer.
  const problems = finishing(set('easy', 'medium', 'medium', 'easy'), 1)
  assert.deepEqual(nextPracticeProblem(problems, { index: 1, ...clean, anyRung3: true }), { index: 0, offerExample: false })
  // The same after an I don't know and after a surrender.
  assert.deepEqual(nextPracticeProblem(problems, { index: 1, ...clean, idk: true }), { index: 0, offerExample: false })
  assert.deepEqual(nextPracticeProblem(problems, { index: 1, ...clean, surrendered: true }), { index: 0, offerExample: false })
})

test('harder after all first try', () => {
  const problems = finishing(set('medium', 'medium', 'hard', 'easy'), 0)
  assert.deepEqual(nextPracticeProblem(problems, { index: 0, ...clean, allFirstTry: true }), { index: 2, offerExample: false })
  // Nothing harder is left: the next one in order.
  const top = finishing(set('hard', 'medium', 'easy'), 0)
  assert.deepEqual(nextPracticeProblem(top, { index: 0, ...clean, allFirstTry: true }), { index: 1, offerExample: false })
})

test('help outranks a clean sweep, and a problem with no stated difficulty counts as medium', () => {
  const problems = finishing(set('easy', null, 'hard'), 1)
  // All first try but a surrender somewhere is not a clean sweep.
  assert.deepEqual(nextPracticeProblem(problems, { index: 1, ...clean, allFirstTry: true, surrendered: true }), { index: 0, offerExample: false })
  // A medium problem finished clean: the null one counts as medium, so the hard one is harder.
  assert.deepEqual(nextPracticeProblem(finishing(set('medium', 'hard', null), 0), { index: 0, ...clean, allFirstTry: true }), { index: 1, offerExample: false })
})
