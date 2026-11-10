import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORED_HINT_RUNG,
  buildPracticeEvidence,
  buildSurrenderEvidence,
  practiceStepEvidence,
  validatePracticeProgress,
  type PracticeState,
} from './practice-evidence'

const empty: PracticeState = { solvedSteps: [], revealedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} }
const step = { firstTryCorrect: false, attempted: true, maxRung: 0 as const, revealed: false, solved: true }

test('reveal without attempt rejected', () => {
  const next = { ...empty, revealedSteps: [0] }
  const result = validatePracticeProgress(empty, next)
  assert.equal(result.ok, false)
  assert.equal(validatePracticeProgress(empty, { ...next, attemptedSteps: [0] }).ok, true)
})

test('impossible transitions are rejected', () => {
  const before: PracticeState = { ...empty, solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { 0: 3 } }
  assert.equal(validatePracticeProgress(before, { ...before, maxRungs: { 0: 1 } }).ok, false)
  assert.equal(validatePracticeProgress(before, { ...before, solvedSteps: [] }).ok, false)
  assert.equal(validatePracticeProgress(before, { ...before, attemptedSteps: [] }).ok, false)
  assert.equal(validatePracticeProgress(empty, { ...empty, solvedSteps: [1] }).ok, false)
  assert.equal(validatePracticeProgress(empty, { ...empty, attemptedSteps: [1], firstTrySteps: [1] }).ok, false)
  assert.equal(validatePracticeProgress(empty, { ...empty, maxRungs: { 0: 9 } }).ok, false)
  // First try cannot be claimed after an earlier checked attempt.
  const missed: PracticeState = { ...empty, attemptedSteps: [2] }
  assert.equal(
    validatePracticeProgress(missed, { ...missed, solvedSteps: [2], attemptedSteps: [2], firstTrySteps: [2] }).ok,
    false
  )
})

test('first try right no help is level 0 score 1', () => {
  assert.deepEqual(practiceStepEvidence({ ...step, firstTryCorrect: true }), { score: 1, assistance: 0 })
})

test('later try right without help is 0.6', () => {
  assert.deepEqual(practiceStepEvidence(step), { score: 0.6, assistance: 0 })
})

test('locate hint keeps level 0 capped at 0.6', () => {
  const locate = { ...step, firstTryCorrect: true, maxRung: AUTHORED_HINT_RUNG[0] as 1 }
  assert.deepEqual(practiceStepEvidence(locate), { score: 0.6, assistance: 0 })
  // Was level 1 before v3.1: the order of trying and asking for a pointer no longer changes the score.
  assert.deepEqual(practiceStepEvidence({ ...locate, firstTryCorrect: false }), { score: 0.6, assistance: 0 })
})

test('connect and structure hints are a failed first try', () => {
  for (const [firstTryCorrect, maxRung] of [
    [true, AUTHORED_HINT_RUNG[1] as 3],
    [true, AUTHORED_HINT_RUNG[2] as 4],
    [false, 3 as const],
  ] as const) {
    assert.deepEqual(practiceStepEvidence({ ...step, firstTryCorrect, maxRung }), { score: 0, assistance: 1 }, `${firstTryCorrect} ${maxRung}`)
  }
})

test('wrong then revealed is level 1 score 0', () => {
  assert.deepEqual(practiceStepEvidence({ ...step, solved: false, revealed: true }), { score: 0, assistance: 1 })
})

test('unfinished step gives null', () => {
  assert.equal(practiceStepEvidence({ ...step, solved: false }), null)
})

test('practice content reads three hints, or the single old hint as the connect hint, and concept ids', async () => {
  const { parsePracticeProblems } = await import('@/features/topic/content')
  const parsed = parsePracticeProblems(
    [
      {
        title: 'P',
        concept_ids: ['c1'],
        steps: [
          { question: 'Q1', correct_answer: 'a', hints: ['look', 'idea', 'form'], hint: 'idea' },
          { question: 'Q2', correct_answer: 'b', hint: 'old hint', concept_ids: ['c2'] },
        ],
      },
    ],
    '2026-01-01'
  )
  const [first, second] = parsed!.items[0].steps
  assert.deepEqual(first.hints, ['look', 'idea', 'form'])
  assert.deepEqual(first.conceptIds, ['c1'])
  assert.deepEqual(second.hints, ['', 'old hint', ''])
  assert.deepEqual(second.conceptIds, ['c2'])
})

test('third check success, second check on two options, and an IDK are level 1', () => {
  assert.deepEqual(practiceStepEvidence({ ...step, checks: 3, solvedOnCheck: 3 }), { score: 0, assistance: 1 })
  assert.deepEqual(practiceStepEvidence({ ...step, checks: 2, solvedOnCheck: 2, twoOption: true }), { score: 0, assistance: 1 })
  assert.deepEqual(practiceStepEvidence({ ...step, checks: 2, solvedOnCheck: 2 }), { score: 0.6, assistance: 0 })
  assert.deepEqual(practiceStepEvidence({ ...step, checks: 2, solvedOnCheck: 2, dontKnow: true }), { score: 0, assistance: 1 })
})

test('a worked example that was only a fallback to an authored hint is not a surrender', () => {
  const afterFallback = { ...step, maxRung: 4 as const, workedDelivered: false }
  assert.deepEqual(practiceStepEvidence(afterFallback), { score: 0, assistance: 1 })
  const base = { userId: 'u', projectId: 'p', topicId: 't', contentId: 'c', problemIndex: 0, conceptIdsOf: () => ['k'], newlyFinished: [0], sessionKey: 's' }
  const solved = { solvedSteps: [0], revealedSteps: [], attemptedSteps: [0], firstTrySteps: [] as number[], maxRungs: { 0: 4 }, missRungs: { 0: 0 } }
  const [fallback] = buildPracticeEvidence({ ...base, next: solved, detail: () => ({ workedDelivered: false }) })
  assert.deepEqual(fallback.metadata, { maxRung: 4 })
  const [delivered] = buildPracticeEvidence({ ...base, next: { ...solved, maxRungs: { 0: 5 } }, detail: () => ({ workedDelivered: true }) })
  assert.deepEqual(delivered.metadata, { maxRung: 5, surrendered: true })
  assert.equal(delivered.assistance, 1)
})

test('an IDK step is recorded as a cue miss with the flag, no confidence and no misconception', () => {
  const base = { userId: 'u', projectId: 'p', topicId: 't', contentId: 'c', problemIndex: 0, conceptIdsOf: () => ['k'], newlyFinished: [0], sessionKey: 's' }
  const [idk] = buildPracticeEvidence({
    ...base,
    next: { solvedSteps: [], revealedSteps: [0], attemptedSteps: [0], firstTrySteps: [], maxRungs: { 0: 1 }, missRungs: {} },
    detail: () => ({ checks: 1, dontKnow: true }),
  })
  assert.deepEqual([idk.score, idk.assistance, idk.confidence], [0, 1, undefined])
  assert.deepEqual(idk.metadata, { maxRung: 1, idk: true, missKind: 'cue_miss' })
})

const finished = {
  userId: 'u1',
  projectId: 'p1',
  topicId: 't1',
  contentId: 'c1',
  problemIndex: 0,
  conceptIdsOf: () => ['k1'],
  newlyFinished: [0],
  sessionKey: 'practice:c1:2026-11-02',
}

test('a delivered worked example is flagged and is a failed first try', () => {
  // The worked example was used (rung 5) before the first check, which was right.
  const state: PracticeState = { ...empty, solvedSteps: [0], attemptedSteps: [0], firstTrySteps: [0], maxRungs: { 0: 5 } }
  const [event] = buildPracticeEvidence({ ...finished, next: state })
  assert.equal(event.assistance, 1)
  assert.equal(event.score, 0)
  assert.deepEqual(event.metadata, { maxRung: 5, surrendered: true })
  // A step that never reached rung 5 carries no flag.
  const [other] = buildPracticeEvidence({ ...finished, next: { ...state, maxRungs: { 0: 4 } } })
  assert.deepEqual(other.metadata, { maxRung: 4 })
})

test('the moment of surrender writes a level-3 event with what the closing retest needs', () => {
  const event = buildSurrenderEvidence({
    userId: 'u1',
    projectId: 'p1',
    topicId: 't1',
    contentId: 'c1',
    problemIndex: 2,
    step: 1,
    conceptIds: ['k1', 'k2'],
    sessionKey: 'practice:c1:2026-11-02',
  })
  assert.ok(event)
  assert.equal(event.itemKey, 'practice:c1:2:1')
  assert.equal(event.source, 'practice')
  assert.equal(event.assistance, 3)
  assert.equal(event.score, 0)
  assert.deepEqual(event.conceptIds, ['k1', 'k2'])
  assert.deepEqual(event.metadata, { maxRung: 5, surrendered: true, contentId: 'c1', problemIndex: 2, step: 1 })
  // A step without concepts writes nothing, like the other practice evidence.
  assert.equal(buildSurrenderEvidence({ userId: 'u1', projectId: 'p1', topicId: 't1', contentId: 'c1', problemIndex: 0, step: 0, conceptIds: [], sessionKey: 's' }), null)
})
