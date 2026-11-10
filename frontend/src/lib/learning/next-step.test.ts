import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, type Plan, type PlanInput, type PlanTopic } from './plan'
import { dueBoundary, isReviewDue, nextStep, nextStepForCourse, type DueTopic } from './next-step'
import { deriveSetup, type CourseSetupInput } from '../course-setup'

// Wednesday 21 October 2026, 15:00 UTC: 8:00 in Los Angeles. The student's today ends at 07:00 UTC
// on the 22nd.
const NOW = new Date('2026-10-21T15:00:00Z')
const ZONE = 'America/Los_Angeles'

function topic(name: string, overrides: Partial<PlanTopic> = {}): PlanTopic {
  return {
    id: name,
    name,
    unitId: null,
    orderIndex: 0,
    prerequisiteIds: [],
    estimatedMinutes: 35,
    examRelevant: false,
    learned: true,
    started: true,
    quizzed: true,
    mastery: 0.5,
    reviewDueAt: null,
    learnedToday: false,
    ...overrides,
  }
}

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

function plan(overrides: Partial<PlanInput> & { topics: PlanTopic[] }): Plan {
  return buildPlan({
    now: NOW,
    timeZone: ZONE,
    examDate: null,
    dailyMinutes: 45,
    units: [],
    unitMocksDone: [],
    fullMocksDoneInFinalWeek: 0,
    doneToday: [],
    ...overrides,
  })
}

/** The due list the way the queries build it: topics whose review falls before the end of the student's today. */
function dueOf(topics: PlanTopic[]): DueTopic[] {
  const boundary = dueBoundary(NOW, ZONE)
  return topics
    .filter((item) => isReviewDue(item.reviewDueAt, boundary))
    .map((item) => ({ topicId: item.id, name: item.name, dueAt: (item.reviewDueAt as Date).toISOString(), mastery: item.mastery }))
}

const COURSE = 'c1'

/** Setup states the way the queries build them. */
const setupOf = (overrides: Partial<CourseSetupInput>) =>
  deriveSetup({
    status: 'setup',
    materialCount: 1,
    topicCount: 2,
    confirmedTopicCount: 0,
    extractedTopicCount: 2,
    confirmedExtractedTopicCount: 0,
    contentBlockCount: 0,
    extraction: 'done',
    ...overrides,
  })

function step(topics: PlanTopic[], overrides: Partial<PlanInput> = {}) {
  const built = plan({ topics, ...overrides })
  return nextStep({ courseId: COURSE, plan: built, due: dueOf(topics), now: NOW, timeZone: ZONE })
}

test("a review is due until the end of the student's day, not the server's", () => {
  const boundary = dueBoundary(NOW, ZONE)
  assert.equal(boundary.toISOString(), '2026-10-22T07:00:00.000Z')
  // 22:00 in Los Angeles tonight: due today for the student, though it is the 22nd in UTC.
  assert.ok(isReviewDue('2026-10-22T05:00:00Z', boundary))
  assert.ok(!isReviewDue('2026-10-22T07:00:00Z', boundary))
  assert.ok(isReviewDue(daysAgo(3), boundary))
  assert.ok(!isReviewDue(null, boundary))
  assert.ok(!isReviewDue(undefined, boundary))
  assert.ok(!isReviewDue('not a date', boundary))
})

test('overdue reviews: the first one is up next and the count is the number of topics due', () => {
  const topics = [
    topic('graphs', { orderIndex: 0, reviewDueAt: daysAgo(2) }),
    topic('hashing', { orderIndex: 1, reviewDueAt: daysAgo(5) }),
    topic('sorting', { orderIndex: 2, reviewDueAt: new Date('2026-10-22T05:00:00Z') }),
  ]
  const result = step(topics)
  assert.equal(result.kind, 'work')
  assert.equal(result.dueCount, 3)
  assert.equal(result.overdueCount, 2)
  assert.match(result.title, /^Review /)
  assert.equal(result.action?.verb, 'Review')
  assert.match(result.action?.href ?? '', /^\/courses\/c1\/review\/session\?topic=/)
  assert.notEqual(result.title, "You're done for today")
  // Everything due is in today's plan, so nothing is waiting behind it.
  assert.equal(result.deferredDue, 0)
})

test("today's time is used up but reviews are overdue: it never says the day is done, and names the same count", () => {
  const topics = [
    topic('graphs', { orderIndex: 0, reviewDueAt: daysAgo(2), mastery: 0.44 }),
    topic('hashing', { orderIndex: 1, reviewDueAt: daysAgo(5), mastery: 0.2 }),
    topic('sorting', { orderIndex: 2, reviewDueAt: daysAgo(1), mastery: 0.6 }),
  ]
  const result = step(topics, { dailyMinutes: 10, doneToday: [{ kind: 'quiz', topicId: 'sorting' }] })
  assert.equal(result.kind, 'reviews_due')
  assert.equal(result.dueCount, 3)
  // The most overdue topic first.
  assert.equal(result.title, 'Review hashing')
  assert.equal(result.action?.href, '/courses/c1/review/session?topic=hashing')
  assert.match(result.reason, /3 reviews are due/)
  assert.match(result.reason, /tomorrow/)
  assert.doesNotMatch(`${result.title} ${result.reason}`, /done for today|caught up/i)
  // The three screens agree: the same due count whatever the plan says.
  const two = [
    topic('graphs', { orderIndex: 0, reviewDueAt: daysAgo(2) }),
    topic('hashing', { orderIndex: 1, reviewDueAt: daysAgo(5) }),
  ]
  const free = step(two)
  const spent = step(two, { dailyMinutes: 10, doneToday: [{ kind: 'quiz', topicId: 'graphs' }] })
  assert.equal(free.dueCount, 2)
  assert.equal(spent.dueCount, 2)
})

test('a new course: setup comes first, then confirming topics, then the first topic', () => {
  const setup = nextStepForCourse({
    courseId: COURSE,
    setup: setupOf({ materialCount: 0, topicCount: 0, extractedTopicCount: 0, extraction: 'none' }),
    plan: null,
    due: [],
    now: NOW,
    timeZone: ZONE,
  })
  assert.equal(setup.kind, 'setup')
  assert.equal(setup.title, 'Upload materials')
  assert.equal(setup.dueCount, 0)
  assert.equal(setup.action?.href, '/courses/c1')

  const empty = nextStep({ courseId: COURSE, plan: plan({ topics: [] }), due: [], now: NOW, timeZone: ZONE })
  assert.equal(empty.kind, 'no_topics')
  assert.equal(empty.action?.href, '/courses/c1/topics')

  // Topics confirmed, nothing learned yet: the first topic is up next, nothing is due.
  const fresh = step([
    topic('graphs', { orderIndex: 0, learned: false, started: false, quizzed: false, mastery: null }),
    topic('hashing', { orderIndex: 1, learned: false, started: false, quizzed: false, mastery: null }),
  ])
  assert.equal(fresh.kind, 'work')
  assert.equal(fresh.dueCount, 0)
  assert.equal(fresh.title, 'Learn graphs')
  assert.equal(fresh.action?.verb, 'Start')
})

test('the last file deleted after Confirm, nothing written yet: upload comes first, not the plan', () => {
  const topics = [topic('graphs', { orderIndex: 0, learned: false, started: false, quizzed: false, mastery: null })]
  const step = nextStepForCourse({
    courseId: COURSE,
    setup: setupOf({ status: 'active', materialCount: 0, topicCount: 1, confirmedTopicCount: 1, extractedTopicCount: 1, confirmedExtractedTopicCount: 1 }),
    plan: plan({ topics }),
    due: [],
    now: NOW,
    timeZone: ZONE,
  })
  assert.equal(step.kind, 'setup')
  assert.equal(step.title, 'Upload materials')
})
