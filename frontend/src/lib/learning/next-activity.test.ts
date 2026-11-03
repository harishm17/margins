import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityHref, nextActivity as cascade, type NextActivityContext, type TopicConceptState, type TopicLearningState } from './next-activity'

const d = (iso: string) => new Date(iso)
const READ = d('2026-10-01T00:00:00Z')
const NOW = d('2026-11-10T15:00:00Z')

const UP: NextActivityContext = { ai: 'up', now: NOW, timeZone: 'UTC' }
const DOWN: NextActivityContext = { ai: 'down', now: NOW, timeZone: 'UTC' }
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

const DOWN_NOTE = 'which is down. This works without it.'

test('misconception beats everything after instruction, including a warm-up that has not been taken', () => {
  const state = fresh({ concepts: [concept('a'), concept('b', { misconception: 'adds instead of multiplies' })] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'fix_misconception')
  assert.deepEqual(next.conceptIds, ['b'])
})

test('misconception beats due review', () => {
  const next = nextActivity(solid({ concepts: [concept('a', { retrievability: 0.5, misconception: 'x' })] }))
  assert.equal(next.kind, 'fix_misconception')
})

test('misconception waits for instruction', () => {
  // A misconception is set by an Again group, which also needs instruction: the reading comes first.
  const state = solid({ concepts: [failed('a', { misconception: 'adds instead of multiplies' }), concept('b')] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'instruct')
  assert.deepEqual(next.conceptIds, ['a'])
  // Once instruction has followed it, the drill that pairs it with its confusable is next.
  const after = solid({ concepts: [concept('a', { misconception: 'adds instead of multiplies', consecutiveFails: 1 }), concept('b')] })
  assert.equal(nextActivity(after).kind, 'fix_misconception')
})

test('zero of N drill sends to instruction first', () => {
  // A 0-of-4 drill: the concept's group was graded Again and nothing has been taught since. The next
  // activity is the instruction, not the same retrieval again, and not a review that re-asks it.
  const state = solid({ concepts: [failed('a', { retrievability: 0.3 }), concept('b')] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'instruct')
  assert.deepEqual(next.conceptIds, ['a'])
  assert.match(next.reason, /Concept a/)
  assert.match(next.reason, /p\. 14/)
  // After the instruction (needsInstruction clears), fresh retrieval is next: the review, a different item.
  const taught = solid({ concepts: [{ ...failed('a', { retrievability: 0.3 }), needsInstruction: false }, concept('b')] })
  assert.equal(nextActivity(taught).kind, 'review')
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

test('instruction comes before the path steps, and the most recent fail leads', () => {
  const state = fresh({ concepts: [failed('a', { lastFailAt: d('2026-11-09T10:00:00Z') }), failed('b', { lastFailAt: d('2026-11-10T10:00:00Z') })] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'instruct')
  assert.deepEqual(next.conceptIds, ['b', 'a'])
})

test('easier step before review for two fails', () => {
  // Fail, instruction, fail again, instruction: two fails in a row and the instruction is in. The student gets an
  // easier step, not the review that would re-ask it.
  const state = solid({
    concepts: [concept('a', { consecutiveFails: 2, mastery: 0.2, retrievability: 0.4, label: 'shaky' })],
  })
  const next = nextActivity(state)
  assert.equal(next.kind, 'examples')
  assert.deepEqual(next.conceptIds, ['a'])
  assert.equal(activityHref(next.kind, { courseId: 'c1', topicId: 't1', conceptIds: next.conceptIds }), '/courses/c1/topics/t1?view=examples&focus=a&fade=full')
})

test('easier step does not repeat without a new fail', () => {
  const state = solid({
    concepts: [concept('a', { consecutiveFails: 2, easierStepSinceFail: true, mastery: 0.2, retrievability: 0.4, label: 'shaky' })],
  })
  // The easier step happened; the review takes over, and a fresh fail would set it up again.
  assert.equal(nextActivity(state).kind, 'review')
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

test('the weakest prerequisite falls back to the first when none was resolved', () => {
  const state = solid({ concepts: [concept('b', { mastery: 0.5, consecutiveFails: 2, prerequisiteIds: ['p1', 'p2'], prerequisiteWeak: true })] })
  assert.deepEqual(nextActivity(state).conceptIds, ['p1', 'b'])
})

test('strong quiz skips read and recall', () => {
  const state = fresh({ warmupAt: READ, testedOutAt: d('2026-11-09T10:00:00Z'), concepts: [concept('a', { mastery: 0.5 }), concept('b', { mastery: 0.6 })] })
  const next = nextActivity(state)
  assert.notEqual(next.kind, 'read')
  assert.notEqual(next.kind, 'recall')
  assert.equal(next.kind, 'practice')
  // Both stay open in the path; the cascade only passes over them. A warm-up that was never taken still comes first.
  assert.equal(nextActivity(fresh({ testedOutAt: d('2026-11-09T10:00:00Z') })).kind, 'warmup')
})

test('quick pass skips read and recall', () => {
  const state = fresh({ warmupAt: READ, triage: 'quick', concepts: [concept('a', { mastery: 0.2, hasQuizEvidence: false })] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'quiz')
  assert.equal(nextActivity(fresh({ triage: 'quick' })).kind, 'warmup')
  // And the instruction loop on misses still runs.
  assert.equal(nextActivity({ ...state, concepts: [failed('a')] }).kind, 'instruct')
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

test('ai down skips recall', () => {
  const state = solid({ recallAt: null, recallGaps: [], concepts: [concept('a', { mastery: 0.5, hasQuizEvidence: false }), concept('b')] })
  assert.equal(nextActivity(state).kind, 'recall')
  const next = nextActivity(state, DOWN)
  assert.notEqual(next.kind, 'recall')
  assert.equal(next.kind, 'quiz')
  assert.match(next.reason, /Recall needs the AI, which is down\. This works without it\./)
  // With the AI up, the reason has no such note.
  assert.doesNotMatch(nextActivity(solid({ concepts: [concept('a', { mastery: 0.5, hasQuizEvidence: false })] })).reason, new RegExp(DOWN_NOTE))
})

test('ai down skips teach back', () => {
  const state = solid({ hardSetOnHand: true, lastHardQuizAt: d('2026-10-10T00:00:00Z'), lastExamAt: d('2026-10-15T00:00:00Z') })
  assert.equal(nextActivity(state).kind, 'teach_back')
  const next = nextActivity(state, DOWN)
  // The next kind that needs no model: the hard set that is already on hand.
  assert.equal(next.kind, 'transfer_quiz')
  assert.match(next.reason, new RegExp(DOWN_NOTE.replace('.', '\\.')))
  // With no hard set on hand a transfer quiz and a mock exam both need the model: practice stands in.
  const none = nextActivity({ ...state, hardSetOnHand: false }, DOWN)
  assert.equal(none.kind, 'practice')
  assert.match(none.reason, /which is down/)
})

test('ai down keeps reread', () => {
  const down = nextActivity(solid({ concepts: [failed('a')] }), DOWN)
  assert.equal(down.kind, 'instruct')
  assert.equal(down.target?.via, 'reread')
  assert.doesNotMatch(down.reason, /which is down/)
  // And pointers need no model: a read step is still offered.
  assert.equal(nextActivity(fresh({ warmupAt: READ }), DOWN).kind, 'read')
})

test('ai down opens a gap explainer only when it is already written', () => {
  const state = solid({ recallGaps: ['b'], concepts: [concept('a'), concept('b')], gapExplainerReadyFor: ['b'] })
  const ready = nextActivity(state, DOWN)
  assert.equal(ready.kind, 'explainer')
  assert.deepEqual(ready.conceptIds, ['b'])
  const missing = nextActivity({ ...state, gapExplainerReadyFor: [] }, DOWN)
  assert.notEqual(missing.kind, 'explainer')
  assert.match(missing.reason, /explainer.*which is down/i)
  assert.equal(nextActivity({ ...state, gapExplainerReadyFor: [] }).kind, 'explainer')
})

test('warmup offered only when ready and not read', () => {
  assert.equal(nextActivity(fresh()).kind, 'warmup')
  assert.equal(nextActivity(fresh({ warmupReady: false })).kind, 'read')
  assert.equal(nextActivity(fresh({ readAt: READ })).kind, 'recall')
})

test('warmup is skipped once taken or once there is evidence', () => {
  assert.equal(nextActivity(fresh({ warmupAt: READ })).kind, 'read')
  assert.equal(nextActivity(fresh({ hasAnyEvidence: true })).kind, 'read')
})

test('read comes before recall and beats a due review', () => {
  const state = fresh({ warmupReady: false, concepts: [concept('a', { retrievability: 0.2 })] })
  assert.equal(nextActivity(state).kind, 'read')
})

test('recall comes after reading and beats gaps and due reviews', () => {
  const state = solid({ recallAt: null, recallGaps: ['a'], concepts: [concept('a', { retrievability: 0.2 })] })
  assert.equal(nextActivity(state).kind, 'recall')
})

test('a recall gap with no explainer visit opens the explainer on the gap concepts', () => {
  const state = solid({ recallGaps: ['b'], concepts: [concept('a', { retrievability: 0.2 }), concept('b')] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'explainer')
  assert.deepEqual(next.conceptIds, ['b'])
})

test('a visited explainer lets a due review through', () => {
  const state = solid({ recallGaps: ['b'], explainerVisitedAt: READ, concepts: [concept('a', { retrievability: 0.2 }), concept('b')] })
  assert.equal(nextActivity(state).kind, 'review')
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

test('a concept without a card is not due', () => {
  const state = solid({ concepts: [concept('a', { retrievability: 0, nUnassisted: 0, hasCard: false, mastery: 0, hasQuizEvidence: true })] })
  assert.notEqual(nextActivity(state).kind, 'review')
  // A card made only of failed first tries (no level-0 event) is due like any other.
  const failedOnly = solid({ concepts: [concept('a', { retrievability: 0.5, nUnassisted: 0, hasCard: true, mastery: 0, hasQuizEvidence: true })] })
  assert.equal(nextActivity(failedOnly).kind, 'review')
})

test('quiz when a concept below 0.8 has no quiz evidence, practice when it has', () => {
  const quiz = nextActivity(solid({ concepts: [concept('a', { mastery: 0.5, hasQuizEvidence: false }), concept('b', { mastery: 0.3 })] }))
  assert.equal(quiz.kind, 'quiz')
  assert.deepEqual(quiz.conceptIds, ['a'])
  const practice = nextActivity(solid({ concepts: [concept('a', { mastery: 0.5 }), concept('b', { mastery: 0.3 })] }))
  assert.equal(practice.kind, 'practice')
  assert.deepEqual(practice.conceptIds, ['b', 'a'])
})

test('solid concepts with too little unaided evidence get practice, not a stretch', () => {
  const state = solid({ concepts: [concept('a'), concept('b', { nUnassisted: 2 })] })
  const next = nextActivity(state)
  assert.equal(next.kind, 'practice')
  assert.deepEqual(next.conceptIds, ['b'])
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
})

test('a kind never done is the oldest', () => {
  const state = solid({ lastTeachBackAt: d('2026-10-20T00:00:00Z'), lastHardQuizAt: d('2026-10-10T00:00:00Z'), lastExamAt: null })
  assert.equal(nextActivity(state).kind, 'mock_exam')
})

test('stretch ties go teach_back first', () => {
  assert.equal(nextActivity(solid()).kind, 'teach_back')
  const same = d('2026-10-10T00:00:00Z')
  const state = solid({ lastTeachBackAt: same, lastHardQuizAt: same, lastExamAt: same })
  assert.equal(nextActivity(state).kind, 'teach_back')
  assert.equal(nextActivity({ ...state, lastTeachBackAt: d('2026-10-11T00:00:00Z') }).kind, 'transfer_quiz')
  assert.equal(nextActivity({ ...state, lastTeachBackAt: d('2026-10-11T00:00:00Z'), lastHardQuizAt: d('2026-10-12T00:00:00Z') }).kind, 'mock_exam')
})

test('stretch loses to everything earlier in the cascade', () => {
  assert.equal(nextActivity(solid({ concepts: [concept('a', { retrievability: 0.8 })] })).kind, 'review')
  assert.equal(nextActivity(solid({ recallGaps: ['a'] })).kind, 'explainer')
})

test('legacy topic without concepts keeps the old path: notes, quiz, then practice', () => {
  const legacy = (overrides: Partial<TopicLearningState>): TopicLearningState =>
    fresh({ concepts: [], warmupReady: true, ...overrides })
  assert.equal(nextActivity(legacy({})).kind, 'read')
  assert.equal(nextActivity(legacy({ readAt: READ })).kind, 'quiz')
  assert.equal(nextActivity(legacy({ readAt: READ, hasAnyEvidence: true })).kind, 'practice')
  // Never recall or warm-up without concepts, whatever else is set.
  assert.equal(nextActivity(legacy({ recallGaps: ['x'], readAt: READ })).kind, 'quiz')
  assert.deepEqual(nextActivity(legacy({})).conceptIds, [])
  // Works the same with the AI down: nothing on the old path needs it.
  assert.equal(nextActivity(legacy({ readAt: READ }), DOWN).kind, 'quiz')
})

test('destinations: drills use the concept drill address', () => {
  const ctx = { courseId: 'c1', topicId: 't1', conceptIds: ['k1', 'k2'] }
  assert.equal(activityHref('fix_misconception', ctx), '/courses/c1/review/session?concept=k1')
  assert.equal(activityHref('prerequisite_drill', ctx), '/courses/c1/review/session?concept=k1')
  assert.equal(activityHref('review', ctx), '/courses/c1/review/session?topic=t1')
})

test('destinations: quiz, exam, teach-back and the in-topic views', () => {
  const ctx = { courseId: 'c1', topicId: 't1', conceptIds: [], unitTopicIds: ['t0', 't1'] }
  assert.equal(activityHref('transfer_quiz', ctx), '/courses/c1/topics/t1?view=quiz&difficulty=hard')
  assert.equal(activityHref('done_for_now', ctx), '/courses/c1/topics/t1?view=quiz&difficulty=hard')
  assert.equal(activityHref('mock_exam', ctx), '/courses/c1/exams/new?topics=t0,t1')
  assert.equal(activityHref('mock_exam', { ...ctx, unitTopicIds: undefined }), '/courses/c1/exams/new?topics=t1')
  assert.equal(activityHref('teach_back', ctx), '/courses/c1/topics/t1?view=recall&mode=teach_back')
  for (const kind of ['warmup', 'read', 'recall', 'explainer', 'quiz', 'practice'] as const) {
    assert.equal(activityHref(kind, ctx), `/courses/c1/topics/t1?view=${kind}`)
  }
})
