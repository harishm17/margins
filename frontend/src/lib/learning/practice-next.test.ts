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

test('example offered when none is easier', () => {
  // The hardest problem is next in order, but nothing is easier than the one that went badly: offer one worked through.
  const easiest = finishing(set('easy', 'medium', 'hard'), 0)
  assert.deepEqual(nextPracticeProblem(easiest, { index: 0, ...clean, anyRung3: true }), { index: 1, offerExample: true })
  // Easier ones exist but are all finished.
  const done = finishing(set('easy', 'medium', 'hard'), 0, 1)
  assert.deepEqual(nextPracticeProblem(done, { index: 1, ...clean, idk: true }), { index: 2, offerExample: true })
  // Nothing left at all: no next problem, and the example is still the way forward.
  const none = finishing(set('medium'), 0)
  assert.deepEqual(nextPracticeProblem(none, { index: 0, ...clean, surrendered: true }), { index: null, offerExample: true })
})

test('harder after all first try', () => {
  const problems = finishing(set('medium', 'medium', 'hard', 'easy'), 0)
  assert.deepEqual(nextPracticeProblem(problems, { index: 0, ...clean, allFirstTry: true }), { index: 2, offerExample: false })
  // Nothing harder is left: the next one in order.
  const top = finishing(set('hard', 'medium', 'easy'), 0)
  assert.deepEqual(nextPracticeProblem(top, { index: 0, ...clean, allFirstTry: true }), { index: 1, offerExample: false })
})

test('in order otherwise', () => {
  const problems = finishing(set('medium', 'hard', 'easy', 'medium'), 0)
  assert.deepEqual(nextPracticeProblem(problems, { index: 0, ...clean }), { index: 1, offerExample: false })
  // After the last problem it wraps to the first one still open.
  const wrap = finishing(set('easy', 'medium', 'hard'), 1, 2)
  assert.deepEqual(nextPracticeProblem(wrap, { index: 2, ...clean }), { index: 0, offerExample: false })
  assert.deepEqual(nextPracticeProblem(finishing(set('easy', 'hard'), 0, 1), { index: 1, ...clean }), { index: null, offerExample: false })
})

test('help outranks a clean sweep, and a problem with no stated difficulty counts as medium', () => {
  const problems = finishing(set('easy', null, 'hard'), 1)
  // All first try but a surrender somewhere is not a clean sweep.
  assert.deepEqual(nextPracticeProblem(problems, { index: 1, ...clean, allFirstTry: true, surrendered: true }), { index: 0, offerExample: false })
  // A medium problem finished clean: the null one counts as medium, so the hard one is harder.
  assert.deepEqual(nextPracticeProblem(finishing(set('medium', 'hard', null), 0), { index: 0, ...clean, allFirstTry: true }), { index: 1, offerExample: false })
})
