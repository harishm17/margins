import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanSteps,
  groupProgress,
  mergeServerProgress,
  parseProgress,
  parseStepKey,
  practiceStepKey,
  problemFinished,
  problemScore,
  progressFromProblems,
  withoutProblem,
  replaceProblem,
  unionSteps,
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

test('progress stored before rungs reads a hint as the connect hint and finished steps as attempted', () => {
  const old = parseProgress(JSON.stringify({ solved: ['a'], revealed: [], hinted: ['c', 3] }))
  assert.deepEqual(old.rungs, { c: 3 })
  assert.deepEqual(old.attempted, ['a'])
})

test('stored rungs and attempts are read back and bad rungs dropped', () => {
  const stored = parseProgress(
    JSON.stringify({ solved: ['a'], revealed: [], hinted: ['a'], attempted: ['a', 'b'], firstTry: ['a'], rungs: { a: 1, b: 9, c: 'x' }, trippedUp: { '0|A': 'sign', '1|B': 4 } })
  )
  assert.deepEqual(stored.rungs, { a: 1 })
  assert.deepEqual(stored.attempted, ['a', 'b'])
  assert.deepEqual(stored.firstTry, ['a'])
  assert.deepEqual(stored.trippedUp, { '0|A': 'sign' })
})

test('local progress is grouped by problem', () => {
  const groups = groupProgress({
    ...none,
    solved: [key(1, 'B', 0), key(0, 'A', 1), key(0, 'A', 0)],
    revealed: [key(0, 'A', 2), key(0, 'A', 1)],
    hinted: [key(1, 'B', 0)],
    attempted: [key(0, 'A', 0), key(0, 'A', 1)],
    firstTry: [key(0, 'A', 0)],
    rungs: { [key(1, 'B', 0)]: 1 },
    missRungs: { [key(0, 'A', 1)]: 0 },
    trippedUp: { '0|A': 'mixed up signs' },
  })
  assert.deepEqual(groups, [
    {
      problemIndex: 0,
      problemTitle: 'A',
      solvedSteps: [0, 1],
      revealedSteps: [2],
      hintedSteps: [],
      attemptedSteps: [0, 1],
      firstTrySteps: [0],
      maxRungs: {},
      missRungs: { '1': 0 },
      trippedUp: 'mixed up signs',
    },
    { problemIndex: 1, problemTitle: 'B', solvedSteps: [0], revealedSteps: [], hintedSteps: [0], attemptedSteps: [], firstTrySteps: [], maxRungs: { '0': 1 }, missRungs: {} },
  ])
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

test('a row from before rungs: its hint is the connect hint, its finished steps are attempted', () => {
  const rows: ProblemProgress[] = [{ problemIndex: 0, problemTitle: 'A', solvedSteps: [0], revealedSteps: [1], hintedSteps: [0] }]
  const progress = progressFromProblems(rows)
  assert.deepEqual(progress.rungs, { [key(0, 'A', 0)]: 3 })
  assert.deepEqual(progress.attempted, [key(0, 'A', 0), key(0, 'A', 1)])
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

test('with nothing on the server everything local is uploaded', () => {
  const local = { ...none, solved: [key(0, 'A', 0)], revealed: [key(1, 'B', 0)], hinted: [], attempted: [key(0, 'A', 0), key(1, 'B', 0)] }
  const { merged, toUpload } = mergeServerProgress(local, [])
  assert.deepEqual(merged, local)
  assert.equal(toUpload.length, 2)
})

test('the score is the steps solved without a hint over all steps', () => {
  assert.equal(problemScore({ solvedSteps: [0, 1, 2], hintedSteps: [] }, 3), 1)
  assert.equal(problemScore({ solvedSteps: [0, 1, 2], hintedSteps: [1] }, 3), 2 / 3)
  assert.equal(problemScore({ solvedSteps: [0], hintedSteps: [0] }, 4), 0)
  assert.equal(problemScore({ solvedSteps: [0, 1], hintedSteps: [] }, 4), 0.5)
  assert.equal(problemScore({ solvedSteps: [], hintedSteps: [] }, 0), 0)
})

test('a problem is finished when every step is solved or shown', () => {
  assert.equal(problemFinished({ solvedSteps: [0, 1], revealedSteps: [2] }, 3), true)
  assert.equal(problemFinished({ solvedSteps: [0, 1], revealedSteps: [] }, 3), false)
  assert.equal(problemFinished({ solvedSteps: [], revealedSteps: [] }, 0), false)
})

test('steps are cleaned for storage', () => {
  assert.deepEqual(cleanSteps({ solvedSteps: [2, 0, 0, 9, -1, 1.5], revealedSteps: [0, 1, 1], hintedSteps: [3, 3] }, 3), {
    solvedSteps: [0, 2],
    revealedSteps: [1],
    hintedSteps: [],
  })
})

test('two states of a problem are joined', () => {
  assert.deepEqual(
    unionSteps(
      { solvedSteps: [0], revealedSteps: [], hintedSteps: [1] },
      { solvedSteps: [1], revealedSteps: [2], hintedSteps: [1] }
    ),
    { solvedSteps: [0, 1], revealedSteps: [2], hintedSteps: [1] }
  )
})

test('one problem can be taken out of the progress, and the server state replace it', () => {
  const progress = {
    ...none,
    revealed: [],
    hinted: [],
    solved: [key(0, 'A', 0), key(1, 'B', 0)],
    attempted: [key(0, 'A', 0), key(1, 'B', 0)],
    rungs: { [key(0, 'A', 0)]: 3, [key(1, 'B', 0)]: 1 },
    missRungs: { [key(0, 'A', 0)]: 0 },
    trippedUp: { '0|A': 'x', '1|B': 'y' },
  }
  const without = withoutProblem(progress, 0, 'A')
  assert.deepEqual(without.solved, [key(1, 'B', 0)])
  assert.deepEqual(without.rungs, { [key(1, 'B', 0)]: 1 })
  assert.deepEqual(without.missRungs, {})
  assert.deepEqual(without.trippedUp, { '1|B': 'y' })
  const server = { problemIndex: 0, problemTitle: 'A', solvedSteps: [2], revealedSteps: [], hintedSteps: [] }
  assert.deepEqual(replaceProblem(progress, 0, 'A', server).solved, [key(1, 'B', 0), key(0, 'A', 2)])
  assert.deepEqual(replaceProblem(progress, 0, 'A', null).solved, [key(1, 'B', 0)])
})
