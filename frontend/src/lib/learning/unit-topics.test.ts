import assert from 'node:assert/strict'
import test from 'node:test'
import { activityWithHref } from './next-activity'
import { unitTopicIds } from './unit-topics'

const topics = [
  { id: 'a', unitId: 'u', confirmed: true },
  { id: 'b', unitId: 'u', confirmed: false },
  { id: 'c', unitId: 'u', confirmed: true },
  { id: 'd', unitId: null, confirmed: true },
]

test('a confirmed list leaves out topics waiting for review; an unconfirmed one keeps all', () => {
  assert.deepEqual(unitTopicIds(topics, 'a', true), ['a', 'c'])
  assert.deepEqual(unitTopicIds(topics, 'a', false), ['a', 'b', 'c'])
})

test('a topic outside every unit stands alone', () => {
  assert.deepEqual(unitTopicIds(topics, 'd', true), ['d'])
})

test('the topic page and the overview give the same mock exam address', () => {
  // The topic page and withTopicActivity (overview, Home, plan) both come through resolveTopicActivity, which calls activityWithHref.
  const d = (iso: string) => new Date(iso)
  const concept = { id: 'k', mastery: 0.9, label: 'solid' as const, retrievability: 0.95, misconception: null, consecutiveFails: 0, nUnassisted: 4, hasCard: true, hasQuizEvidence: true, prerequisiteIds: [], band: 1 as const, needsInstruction: false, easierStepSinceFail: false, latestGroupGoodToday: false, lastFailAt: null, firstClaim: null, prerequisiteWeak: false }
  const state = {
    concepts: [concept],
    prepared: true,
    practiceDone: true,
    practiceWritten: true,
    warmupReady: true,
    warmupAt: d('2026-09-01'),
    readAt: d('2026-09-02'),
    recallAt: d('2026-09-03'),
    recallGaps: [],
    explainerVisitedAt: null,
    lastTeachBackAt: d('2026-10-20'),
    lastHardQuizAt: d('2026-10-21'),
    lastExamAt: null,
    hasAnyEvidence: true,
    testedOutAt: null,
    triage: null,
    gapExplainerReadyFor: [],
    hardSetOnHand: false,
    nextReviewAt: null,
  }
  const ctx = { courseId: 'c1', topicId: 'a', topics, listConfirmed: true, ai: 'up' as const, now: new Date('2026-11-10T00:00:00Z'), timeZone: 'UTC' }
  const next = activityWithHref(state, ctx)
  assert.equal(next.kind, 'mock_exam')
  assert.equal(next.href, '/courses/c1/exams/new?topics=a,c')
  assert.equal(activityWithHref(state, { ...ctx, listConfirmed: false }).href, '/courses/c1/exams/new?topics=a,b,c')
})
