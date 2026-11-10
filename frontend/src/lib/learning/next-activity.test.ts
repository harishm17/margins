import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityHref, nextActivity as cascade, type NextActivityContext, type TopicConceptState, type TopicLearningState } from './next-activity'

const d = (iso: string) => new Date(iso)
const READ = d('2026-10-01T00:00:00Z')
const NOW = d('2026-11-10T15:00:00Z')

const UP: NextActivityContext = { ai: 'up', now: NOW, timeZone: 'UTC' }
const nextActivity = (s: TopicLearningState, ctx: NextActivityContext = UP) => cascade(s, ctx)

function concept(id: string, overrides: Partial<TopicConceptState> = {}): TopicConceptState {
  return {
    id,
    name: `Concept ${id}`,
    mastery: 0.9,
    label: 'solid',
    retrievability: 0.95,
    misconception: null,
    consecutiveFails: 0,
    nUnassisted: 4,
    hasCard: true,
    hasQuizEvidence: true,
    prerequisiteIds: [],
    band: 1,
    needsInstruction: false,
    easierStepSinceFail: false,
    latestGroupGoodToday: false,
    lastFailAt: null,
    firstClaim: null,
    prerequisiteWeak: false,
    ...overrides,
  }
}

// A concept that failed and has not been taught since.
const failed = (id: string, overrides: Partial<TopicConceptState> = {}) =>
  concept(id, { mastery: 0.1, label: 'shaky', retrievability: 0.5, consecutiveFails: 1, needsInstruction: true, lastFailAt: d('2026-11-10T14:00:00Z'), firstClaim: { page: 14, chunkId: 'chunk-14' }, ...overrides })

// A topic that is read, recalled and solid everywhere: only the stretch rotation is left.
function solid(overrides: Partial<TopicLearningState> = {}): TopicLearningState {
  return {
    concepts: [concept('a'), concept('b')],
    prepared: true,
    practiceDone: true,
    practiceWritten: true,
    warmupReady: true,
    warmupAt: d('2026-09-30T00:00:00Z'),
    readAt: READ,
    recallAt: READ,
    recallGaps: [],
    explainerVisitedAt: null,
    lastTeachBackAt: null,
    lastHardQuizAt: null,
    lastExamAt: null,
    hasAnyEvidence: true,
    testedOutAt: null,
    triage: null,
    gapExplainerReadyFor: [],
    hardSetOnHand: false,
    nextReviewAt: null,
    ...overrides,
  }
}

// A brand-new topic with concepts and a ready warm-up.
const fresh = (overrides: Partial<TopicLearningState> = {}): TopicLearningState =>
  solid({ warmupAt: null, readAt: null, recallAt: null, hasAnyEvidence: false, ...overrides })

test('misconception beats everything after instruction, including a warm-up that has not been taken', () => {
  const state = fresh({ concepts: [concept('a'), concept('b', { misconception: 'adds instead of multiplies' })] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'fix_misconception')
  assert.deepEqual(next.conceptIds, ['b'])
})

test('instruction goes to the gap explainer when ready, else reread', () => {
  const state = solid({ concepts: [failed('a'), concept('b')] })
  const reread = nextActivity(state)
  assert.equal(reread.kind, 'instruct')
  assert.deepEqual(reread.target, { conceptId: 'a', via: 'reread', chunkId: 'chunk-14' })
  const ready = nextActivity({ ...state, gapExplainerReadyFor: ['a'] })
  assert.equal(ready.kind, 'instruct')
  assert.deepEqual(ready.target, { conceptId: 'a', via: 'explainer', chunkId: 'chunk-14' })
  assert.equal(activityHref('instruct', { courseId: 'c1', topicId: 't1', conceptIds: ['a'], target: reread.target }), '/courses/c1/topics/t1?view=read&focus=a#chunk-chunk-14')
  assert.equal(activityHref('instruct', { courseId: 'c1', topicId: 't1', conceptIds: ['a'], target: ready.target }), '/courses/c1/topics/t1?view=explainer&focus=a')
  // A concept whose first claim has no chunk rereads the topic at the concept.
  const noChunk = nextActivity(solid({ concepts: [failed('a', { firstClaim: { page: null, chunkId: null } })] }))
  assert.equal(activityHref('instruct', { courseId: 'c1', topicId: 't1', conceptIds: ['a'], target: noChunk.target }), '/courses/c1/topics/t1?view=read&focus=a')
  assert.doesNotMatch(noChunk.reason, /p\./)
})

test('prerequisite drill when a prerequisite is weak, else examples', () => {
  const stuck = (over: Partial<TopicConceptState>) => concept('b', { mastery: 0.5, consecutiveFails: 2, prerequisiteIds: ['p1', 'p2'], weakestPrerequisiteId: 'p2', ...over })
  const weak = nextActivity(solid({ concepts: [stuck({ prerequisiteWeak: true })] }))
  assert.equal(weak.kind, 'prerequisite_drill')
  // The drill targets the weakest prerequisite; the failing concept follows it.
  assert.deepEqual(weak.conceptIds, ['p2', 'b'])
  assert.equal(activityHref(weak.kind, { courseId: 'c1', topicId: 't1', conceptIds: weak.conceptIds }), '/courses/c1/review/session?concept=p2')
  const strong = nextActivity(solid({ concepts: [stuck({ prerequisiteWeak: false })] }))
  assert.equal(strong.kind, 'examples')
  // No prerequisite at all: the examples at full support.
  assert.equal(nextActivity(solid({ concepts: [concept('c', { consecutiveFails: 3, mastery: 0.5 })] })).kind, 'examples')
  // One fail is not enough.
  assert.equal(nextActivity(solid({ concepts: [concept('c', { consecutiveFails: 1, mastery: 0.5 })] })).kind, 'practice')
})

test('done for now when every concept was Good today', () => {
  const state = solid({
    nextReviewAt: d('2026-11-13T15:00:00Z'),
    concepts: [concept('a', { latestGroupGoodToday: true, nUnassisted: 1, mastery: 0.5 }), concept('b', { latestGroupGoodToday: true, nUnassisted: 1, mastery: 0.5 })],
  })
  const next = nextActivity(state)
  assert.equal(next.kind, 'done_for_now')
  assert.match(next.reason, /Solid for now/)
  assert.match(next.reason, /Nov 13/)
  assert.equal(activityHref(next.kind, { courseId: 'c1', topicId: 't1', conceptIds: [] }), '/courses/c1/topics/t1?view=quiz&difficulty=hard')
  // One concept not done today, or one due, and it is not done for now.
  assert.notEqual(nextActivity({ ...state, concepts: [state.concepts[0], concept('b', { nUnassisted: 1, mastery: 0.5 })] }).kind, 'done_for_now')
  assert.equal(nextActivity({ ...state, concepts: [state.concepts[0], { ...state.concepts[1], retrievability: 0.5 }] }).kind, 'review')
  // The date is read in the student's zone.
  const evening = nextActivity(state, { ...UP, timeZone: 'Pacific/Auckland' })
  assert.match(evening.reason, /Nov 14/)
  assert.equal(nextActivity({ ...state, nextReviewAt: null }).reason, 'Solid for now.')
})

test('read comes before recall and beats a due review', () => {
  const state = fresh({ warmupReady: false, concepts: [concept('a', { retrievability: 0.2 })] })
  assert.equal(nextActivity(state).kind, 'read')
})

test('recall comes after reading and beats gaps and due reviews', () => {
  const state = solid({ recallAt: null, recallGaps: ['a'], concepts: [concept('a', { retrievability: 0.2 })] })
  assert.equal(nextActivity(state).kind, 'recall')
})

test('review lists due concepts, least retrievable first, and beats a quiz or practice', () => {
  const state = solid({
    concepts: [
      concept('a', { retrievability: 0.85 }),
      concept('b', { retrievability: 0.4, consecutiveFails: 1, prerequisiteIds: ['a'] }),
      concept('c'),
    ],
  })
  const next = nextActivity(state)
  assert.equal(next.kind, 'review')
  assert.deepEqual(next.conceptIds, ['b', 'a'])
})

test('quiz when a concept below 0.8 has no quiz evidence, practice when it has', () => {
  const quiz = nextActivity(solid({ concepts: [concept('a', { mastery: 0.5, hasQuizEvidence: false }), concept('b', { mastery: 0.3 })] }))
  assert.equal(quiz.kind, 'quiz')
  assert.deepEqual(quiz.conceptIds, ['a'])
  const practice = nextActivity(solid({ concepts: [concept('a', { mastery: 0.5 }), concept('b', { mastery: 0.3 })] }))
  assert.equal(practice.kind, 'practice')
  assert.deepEqual(practice.conceptIds, ['b', 'a'])
})

test('stretch picks the kind with the oldest evidence', () => {
  const state = solid({
    hardSetOnHand: true,
    lastTeachBackAt: d('2026-10-20T00:00:00Z'),
    lastHardQuizAt: d('2026-10-10T00:00:00Z'),
    lastExamAt: d('2026-10-15T00:00:00Z'),
  })
  assert.equal(nextActivity(state).kind, 'transfer_quiz')
  assert.equal(nextActivity({ ...state, lastExamAt: d('2026-10-01T00:00:00Z') }).kind, 'mock_exam')
  assert.equal(nextActivity({ ...state, lastTeachBackAt: d('2026-10-01T00:00:00Z') }).kind, 'teach_back')
  // A kind never done is the oldest.
  const neverExam = solid({ lastTeachBackAt: d('2026-10-20T00:00:00Z'), lastHardQuizAt: d('2026-10-10T00:00:00Z'), lastExamAt: null })
  assert.equal(nextActivity(neverExam).kind, 'mock_exam')
})
