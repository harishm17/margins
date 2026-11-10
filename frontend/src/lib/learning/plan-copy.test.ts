import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, type PlanItem, type PlanTopic } from './plan'
import { planItemHref, upNextFromPlan, } from './plan-copy'
import { nextActionsFromPlan, setupNextAction } from './next-actions'

const item = (over: Partial<PlanItem>): PlanItem => ({
  id: 'x',
  kind: 'learn',
  date: '2026-10-21',
  title: 'Learn Graph traversal',
  topicId: 't1',
  unitId: null,
  topicIds: ['t1'],
  minutes: 35,
  done: false,
  part: null,
  note: null,
  projected: false,
  ...over,
})

test('each kind of item links to its action', () => {
  assert.equal(planItemHref(item({}), 'c1'), '/courses/c1/topics/t1')
  assert.equal(planItemHref(item({ kind: 'quiz' }), 'c1'), '/courses/c1/topics/t1?view=quiz')
  assert.equal(
    planItemHref(item({ kind: 'unit_mock', topicId: null, topicIds: ['a', 'b', 'c'] }), 'c1'),
    '/courses/c1/exams/new?topics=a,b,c'
  )
  assert.equal(planItemHref(item({ kind: 'full_mock', topicId: null, topicIds: ['a'] }), 'c1'), '/courses/c1/exams/new?topics=all')
})

test('plan review item opens topic-filtered session', () => {
  assert.equal(planItemHref(item({ kind: 'review' }), 'c1'), '/courses/c1/review/session?topic=t1')
  assert.equal(planItemHref(item({ kind: 'review', topicId: null, topicIds: [] }), 'c1'), '/courses/c1/review/session')
  // A projected review has no due concepts yet: it stays a quiz on the topic.
  assert.equal(planItemHref(item({ kind: 'review', projected: true }), 'c1'), '/courses/c1/topics/t1?view=quiz')
})

const topic = (id: string, over: Partial<PlanTopic> = {}): PlanTopic => ({
  id,
  name: id,
  unitId: null,
  orderIndex: 0,
  prerequisiteIds: [],
  estimatedMinutes: 35,
  examRelevant: false,
  learned: false,
  started: false,
  quizzed: false,
  mastery: null,
  reviewDueAt: null,
  learnedToday: false,
  ...over,
})

const planFor = (topics: PlanTopic[], doneToday: Parameters<typeof buildPlan>[0]['doneToday'] = []) =>
  buildPlan({
    now: new Date('2026-10-21T15:00:00Z'),
    timeZone: 'UTC',
    examDate: null,
    dailyMinutes: 45,
    topics,
    units: [],
    unitMocksDone: [],
    fullMocksDoneInFinalWeek: 0,
    doneToday,
  })

test("Up next is today's items still to do, and done items are kept apart", () => {
  const plan = planFor(
    [topic('a', { orderIndex: 0, learned: true, learnedToday: true }), topic('b', { orderIndex: 1 })],
    [{ kind: 'learn', topicId: 'a' }]
  )
  const data = upNextFromPlan(plan, 'c1')
  assert.deepEqual(data.doneToday.map((entry) => entry.title), ['Learn a'])
  assert.deepEqual(data.upNext, [])
  // Today is full (35 done of 45): b is tomorrow.
  assert.equal(data.later?.item.title, 'Quiz: a')
  assert.equal(data.later?.date, '2026-10-22')
})

test('the next-actions API lists today\'s items in order, and the setup step before that', () => {
  const plan = planFor([topic('a', { orderIndex: 0 }), topic('b', { orderIndex: 1 })])
  const actions = nextActionsFromPlan(plan)
  assert.deepEqual(actions.map((action) => [action.type, action.topicId, action.etaMinutes, action.priority]), [['study_topic', 'a', 35, 0]])
  assert.equal(setupNextAction('c1', { mode: 'active', step: null, label: null }, 3), null)
  assert.equal(setupNextAction('c1', { mode: 'setup', step: 1, label: 'x' }, 0)?.type, 'upload_materials')
  assert.equal(setupNextAction('c1', { mode: 'setup', step: 2, label: 'x' }, 0)?.type, 'extract_topics')
  assert.equal(setupNextAction('c1', { mode: 'setup', step: 2, label: 'x' }, 4)?.type, 'confirm_topics')
  assert.equal(setupNextAction('c1', { mode: 'setup', step: 3, label: 'x' }, 4), null)
})

test('a review of a topic without concepts keeps the quiz-based review card', () => {
  const withConcepts = new Set(['t2'])
  assert.equal(planItemHref(item({ kind: 'review' }), 'c1', withConcepts), '/courses/c1/review#review-t1')
  assert.equal(planItemHref(item({ kind: 'review', topicId: 't2' }), 'c1', withConcepts), '/courses/c1/review/session?topic=t2')
  // Without the flag every topic is taken to have concepts.
  assert.equal(planItemHref(item({ kind: 'review' }), 'c1'), '/courses/c1/review/session?topic=t1')
})
