import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, type Plan, type PlanInput, type PlanTopic } from './plan'
import { dueBoundary, isReviewDue, nextStep, nextStepForCourse, type DueTopic } from './next-step'

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
const active = { mode: 'active', step: null, label: null } as const

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
  assert.match(result.action?.href ?? '', /^\/courses\/c1\/review#review-/)
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
  assert.equal(result.action?.href, '/courses/c1/review#review-hashing')
  assert.match(result.reason, /3 reviews are due/)
  assert.match(result.reason, /tomorrow/)
  assert.doesNotMatch(`${result.title} ${result.reason}`, /done for today|caught up/i)
})

test('one review due after the plan is full is described in the singular', () => {
  const topics = [topic('graphs', { reviewDueAt: daysAgo(2) })]
  const result = step(topics, { dailyMinutes: 10, doneToday: [{ kind: 'quiz', topicId: 'graphs' }] })
  assert.equal(result.kind, 'reviews_due')
  assert.equal(result.dueCount, 1)
  assert.match(result.reason, /^Due /)
})

test('reviews that did not fit today are counted so the screen can say they are waiting', () => {
  // Five overdue reviews at 10 minutes each do not all fit in 45 minutes.
  const topics = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) =>
    topic(name, { orderIndex: index, reviewDueAt: daysAgo(2 + index), mastery: 0.4 })
  )
  const result = step(topics)
  assert.equal(result.kind, 'work')
  assert.equal(result.dueCount, 6)
  assert.ok(result.deferredDue > 0)
  assert.ok(result.deferredDue < 6)
})

test('nothing due and nothing planned: done for today only when something was done', () => {
  const topics = [topic('graphs')]
  const quiet = step(topics)
  assert.equal(quiet.kind, 'clear')
  assert.equal(quiet.dueCount, 0)
  assert.equal(quiet.title, 'Nothing planned for today')
  assert.equal(quiet.action?.verb, 'New mock exam')

  const worked = step(topics, { doneToday: [{ kind: 'quiz', topicId: 'graphs' }] })
  assert.equal(worked.kind, 'clear')
  assert.equal(worked.title, "You're done for today")
  assert.equal(worked.doneToday, 1)
})

test("when today is clear and something is planned later, it names the next day's first item", () => {
  const topics = [
    topic('graphs', { orderIndex: 0, reviewDueAt: new Date('2026-10-23T20:00:00Z') }),
    topic('hashing', { orderIndex: 1, learned: false, started: false, quizzed: false, mastery: null }),
  ]
  const result = step(topics, { dailyMinutes: 10, doneToday: [{ kind: 'learn', topicId: 'hashing' }] })
  assert.equal(result.kind, 'clear')
  assert.ok(result.later)
  assert.match(result.reason, /^Next: /)
  assert.equal(result.action, null)
})

test('exam soon: the countdown and the plan warning travel with the step', () => {
  const topics = ['a', 'b', 'c', 'd', 'e'].map((name, index) =>
    topic(name, { orderIndex: index, learned: false, started: false, quizzed: false, mastery: null, estimatedMinutes: 60 })
  )
  const result = step(topics, { examDate: '2026-10-24', dailyMinutes: 60 })
  assert.equal(result.exam.label, 'Exam in 3 days')
  assert.ok(result.exam.short)
  assert.ok(result.exam.shortMessage)
  assert.equal(result.kind, 'work')
  assert.equal(result.action?.verb, 'Start')

  assert.equal(step(topics, { examDate: '2026-10-22' }).exam.label, 'Exam tomorrow')
  assert.equal(step(topics, { examDate: '2026-10-21' }).exam.label, 'Exam today')
  assert.equal(step(topics).exam.label, null)
})

test('exam soon with reviews overdue: the full mock has the day, and the card counts the reviews waiting', () => {
  const topics = [
    topic('graphs', { orderIndex: 0, reviewDueAt: daysAgo(2) }),
    topic('hashing', { orderIndex: 1, reviewDueAt: daysAgo(1) }),
  ]
  // Two days out, today is the last full mock: 60 minutes on a 45-minute day, alone and marked. The
  // overdue reviews no longer pile on top of it; they wait (tomorrow is the final review of both).
  const result = step(topics, { examDate: '2026-10-23' })
  assert.equal(result.exam.label, 'Exam in 2 days')
  assert.equal(result.dueCount, 2)
  assert.equal(result.title, 'Full mock exam')
  assert.equal(result.overBudgetLabel, 'Longer than your usual 45 minutes')
  assert.equal(result.minutesLeft, 60)
  assert.equal(result.deferredDue, 2)
})

test('exam date passed: reviews still due come first, otherwise the date is asked for', () => {
  const topics = [topic('graphs', { reviewDueAt: daysAgo(2) })]
  const due = step(topics, { examDate: '2026-10-17' })
  assert.equal(due.kind, 'reviews_due')
  assert.equal(due.dueCount, 1)
  assert.match(due.reason, /exam date has passed/i)

  const none = step([topic('graphs')], { examDate: '2026-10-17' })
  assert.equal(none.kind, 'exam_passed')
  assert.equal(none.action?.verb, 'Change the date')
  assert.equal(none.action?.href, '/courses/c1/settings')
})

test('a new course: setup comes first, then confirming topics, then the first topic', () => {
  const setup = nextStepForCourse({
    courseId: COURSE,
    setup: { mode: 'setup', step: 1, label: 'Upload materials' },
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

test('the three screens agree: same due count whatever the plan says', () => {
  const topics = [
    topic('graphs', { orderIndex: 0, reviewDueAt: daysAgo(2) }),
    topic('hashing', { orderIndex: 1, reviewDueAt: daysAgo(5) }),
  ]
  const free = step(topics)
  const spent = step(topics, { dailyMinutes: 10, doneToday: [{ kind: 'quiz', topicId: 'graphs' }] })
  assert.equal(free.dueCount, 2)
  assert.equal(spent.dueCount, 2)
})
