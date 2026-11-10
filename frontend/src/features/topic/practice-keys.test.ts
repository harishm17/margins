import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupProgress,
  mergeServerProgress,
  parseProgress,
  parseStepKey,
  practiceStepKey,
  problemScore,
  progressFromProblems,
  type ProblemProgress,
} from './practice-keys'

const key = practiceStepKey

test('a step key is read back, even when the title has bars in it', () => {
  assert.deepEqual(parseStepKey(key(2, 'Bayes rule', 1)), { problemIndex: 2, title: 'Bayes rule', stepIndex: 1 })
  assert.deepEqual(parseStepKey(key(0, 'A | B', 3)), { problemIndex: 0, title: 'A | B', stepIndex: 3 })
  assert.deepEqual(parseStepKey(key(0, '', 0)), { problemIndex: 0, title: '', stepIndex: 0 })
  assert.equal(parseStepKey('nonsense'), null)
  assert.equal(parseStepKey('x|title|1'), null)
  assert.equal(parseStepKey('1|title|y'), null)
  assert.equal(parseStepKey('-1|title|1'), null)
})

const none = { attempted: [], firstTry: [], rungs: {}, missRungs: {}, trippedUp: {} }

test('stored progress parses with and without hints, and survives garbage', () => {
  assert.deepEqual(parseProgress(JSON.stringify({ solved: ['a'], revealed: ['b'] })), {
    solved: ['a'],
    revealed: ['b'],
    hinted: [],
    ...none,
    attempted: ['a', 'b'],
  })
  assert.deepEqual(parseProgress('{oops'), { solved: [], revealed: [], hinted: [], ...none })
  assert.deepEqual(parseProgress(null), { solved: [], revealed: [], hinted: [], ...none })
})

test('server rows turn back into the keys the views use', () => {
  const rows: ProblemProgress[] = [
    {
      problemIndex: 1,
      problemTitle: 'B',
      solvedSteps: [0, 2],
      revealedSteps: [1],
      hintedSteps: [2],
      attemptedSteps: [0, 1, 2],
      firstTrySteps: [0],
      maxRungs: { '2': 1 },
      missRungs: { '1': 0 },
    },
  ]
  assert.deepEqual(progressFromProblems(rows), {
    solved: [key(1, 'B', 0), key(1, 'B', 2)],
    revealed: [key(1, 'B', 1)],
    hinted: [key(1, 'B', 2)],
    attempted: [key(1, 'B', 0), key(1, 'B', 1), key(1, 'B', 2)],
    firstTry: [key(1, 'B', 0)],
    rungs: { [key(1, 'B', 2)]: 1 },
    missRungs: { [key(1, 'B', 1)]: 0 },
    trippedUp: {},
  })
  assert.deepEqual(groupProgress(progressFromProblems(rows)), rows)
})

test('the server wins for problems it has a row for; local-only problems are kept and uploaded', () => {
  const local = {
    ...none,
    solved: [key(0, 'A', 0), key(0, 'A', 1), key(2, 'C', 0)],
    revealed: [],
    hinted: [],
  }
  const server: ProblemProgress[] = [{ problemIndex: 0, problemTitle: 'A', solvedSteps: [0], revealedSteps: [], hintedSteps: [] }]
  const { merged, toUpload } = mergeServerProgress(local, server)
  assert.deepEqual(merged.solved.sort(), [key(0, 'A', 0), key(2, 'C', 0)].sort())
  assert.deepEqual(toUpload.map((group) => group.problemIndex), [2])
})

test('a problem started over on another device stays started over', () => {
  const local = { ...none, solved: [key(0, 'A', 0), key(0, 'A', 1)], revealed: [], hinted: [] }
  const server: ProblemProgress[] = [{ problemIndex: 0, problemTitle: 'A', solvedSteps: [], revealedSteps: [], hintedSteps: [] }]
  const { merged, toUpload } = mergeServerProgress(local, server)
  assert.deepEqual(merged, { solved: [], revealed: [], hinted: [], ...none })
  assert.deepEqual(toUpload, [])
})

test('progress for a problem that was rewritten (same place, new title) is not carried over', () => {
  const local = { ...none, solved: [key(0, 'Old title', 0)], revealed: [], hinted: [] }
  const server: ProblemProgress[] = [{ problemIndex: 0, problemTitle: 'New title', solvedSteps: [1], revealedSteps: [], hintedSteps: [] }]
  const { merged, toUpload } = mergeServerProgress(local, server)
  assert.deepEqual(merged.solved, [key(0, 'New title', 1)])
  assert.deepEqual(toUpload, [])
})

test('the score is the steps solved without a hint over all steps', () => {
  assert.equal(problemScore({ solvedSteps: [0, 1, 2], hintedSteps: [] }, 3), 1)
  assert.equal(problemScore({ solvedSteps: [0, 1, 2], hintedSteps: [1] }, 3), 2 / 3)
  assert.equal(problemScore({ solvedSteps: [0], hintedSteps: [0] }, 4), 0)
  assert.equal(problemScore({ solvedSteps: [0, 1], hintedSteps: [] }, 4), 0.5)
  assert.equal(problemScore({ solvedSteps: [], hintedSteps: [] }, 0), 0)
})
