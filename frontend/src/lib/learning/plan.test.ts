import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  buildPlan,
  daysBetween,
  fitsInDays,
  isDayString,
  learnMinutesLeft,
  learnOrder,
  localDay,
  todayItems,
  weekStart,
  type DoneToday,
  type Plan,
  type PlanInput,
  type PlanItem,
  type PlanTopic,
} from './plan'

// Wednesday 21 October 2026, 15:00 UTC (8:00 in Los Angeles, 11:00 in New York).
const NOW = new Date('2026-10-21T15:00:00Z')
const TODAY = '2026-10-21'

function topic(name: string, overrides: Partial<PlanTopic> = {}): PlanTopic {
  return {
    id: name,
    name,
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
    ...overrides,
  }
}

/** Topics a, b, c ... in that order. */
const course = (count: number, overrides: Partial<PlanTopic> = {}): PlanTopic[] =>
  Array.from({ length: count }, (_, index) => topic(String.fromCharCode(97 + index), { orderIndex: index, ...overrides }))

function plan(overrides: Partial<PlanInput> & { topics: PlanTopic[] }): Plan {
  return buildPlan({
    now: NOW,
    timeZone: 'UTC',
    examDate: null,
    dailyMinutes: 45,
    units: [],
    unitMocksDone: [],
    fullMocksDoneInFinalWeek: 0,
    doneToday: [],
    ...overrides,
  })
}

const items = (result: Plan, kind?: PlanItem['kind']) =>
  result.days.flatMap((day) => day.items).filter((item) => (kind ? item.kind === kind : true))
const dayOf = (result: Plan, topicId: string, kind: PlanItem['kind']) =>
  items(result, kind).find((item) => item.topicId === topicId)?.date
const learnDays = (result: Plan) => items(result, 'learn').map((item) => `${item.topicId}@${item.date}`)
/** The topics with learning in the plan (a split topic once). */
const learnTopics = (result: Plan) => new Set(items(result, 'learn').map((item) => item.topicId as string))

test('day helpers: add, difference, week start, validation', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(daysBetween('2026-10-21', '2026-12-14'), 54)
  assert.equal(daysBetween('2026-10-21', '2026-10-19'), -2)
  assert.equal(weekStart('2026-10-21'), '2026-10-19')
  assert.equal(weekStart('2026-10-25'), '2026-10-19')
  assert.equal(weekStart('2026-10-26'), '2026-10-26')
  assert.ok(isDayString('2026-02-28'))
  assert.ok(!isDayString('2026-02-30'))
  assert.ok(!isDayString('tomorrow'))
  assert.ok(!isDayString(null))
})

test("days are the student's days: the same instant is a different date in another zone", () => {
  const instant = new Date('2026-10-21T03:00:00Z')
  assert.equal(localDay(instant, 'UTC'), '2026-10-21')
  assert.equal(localDay(instant, 'America/Los_Angeles'), '2026-10-20')
  assert.equal(localDay(instant, 'Asia/Tokyo'), '2026-10-21')
  const west = plan({ topics: course(1), now: instant, timeZone: 'America/Los_Angeles' })
  assert.equal(west.today, '2026-10-20')
  assert.equal(west.days[0].date, '2026-10-20')
  assert.ok(west.days[0].isToday)
})

test("review due days are converted to the student's days", () => {
  // 02:00 UTC on the 22nd is still the 21st in Los Angeles: due today there, tomorrow in UTC.
  const due = new Date('2026-10-22T02:00:00Z')
  const topics = [topic('a', { learned: true, quizzed: true, mastery: 0.5, reviewDueAt: due })]
  const la = plan({ topics, timeZone: 'America/Los_Angeles', now: new Date('2026-10-21T20:00:00Z') })
  assert.equal(dayOf(la, 'a', 'review'), '2026-10-21')
  const utc = plan({ topics, timeZone: 'UTC', now: new Date('2026-10-21T20:00:00Z') })
  assert.equal(dayOf(utc, 'a', 'review'), '2026-10-22')
})

test('no topics, and an exam in the past', () => {
  assert.equal(plan({ topics: [] }).status, 'no_topics')
  const past = plan({ topics: course(2), examDate: '2026-10-20' })
  assert.equal(past.status, 'exam_passed')
  assert.deepEqual(past.days, [])
  assert.equal(past.daysToExam, -1)
})

test('without an exam date the plan is the next 14 days', () => {
  const result = plan({ topics: course(3) })
  assert.equal(result.mode, 'rolling')
  assert.equal(result.days.length, 14)
  assert.equal(result.days[0].date, TODAY)
  assert.equal(result.days[13].date, '2026-11-03')
  assert.equal(result.examDate, null)
  assert.equal(result.daysToExam, null)
  assert.equal(result.short, false)
})

test('learn blocks follow course order and pack into the daily minutes without running over', () => {
  // 35-minute topics and 45 minutes a day. The day after a topic holds its 15-minute quiz, so the next
  // topic does not fit whole: it is split (parts of at least 15) rather than run 5 minutes over.
  const result = plan({ topics: course(4) })
  assert.deepEqual(learnDays(result), ['a@2026-10-21', 'b@2026-10-22', 'b@2026-10-23', 'c@2026-10-23', 'c@2026-10-24', 'd@2026-10-24', 'd@2026-10-25'])
  assert.ok(items(result, 'learn').every((item) => item.minutes >= 15))
  for (const id of ['b', 'c', 'd']) {
    const parts = items(result, 'learn').filter((item) => item.topicId === id)
    assert.deepEqual(parts.map((item) => item.part), [{ number: 1, of: 2 }, { number: 2, of: 2 }])
    assert.equal(parts.reduce((sum, item) => sum + item.minutes, 0), 35)
  }
  assert.ok(result.days.every((day) => day.minutes <= 45))
})

test('short topics share a day', () => {
  const result = plan({ topics: course(4, { estimatedMinutes: 20 }), dailyMinutes: 45 })
  // 20 + 20 = 40 fits, then 5 minutes is left: too little for a part of 15.
  assert.deepEqual(
    result.days[0].items.filter((item) => item.kind === 'learn').map((item) => item.topicId),
    ['a', 'b']
  )
})

test('a topic longer than what is left of the day is split into parts', () => {
  const topics = [topic('long', { orderIndex: 0, estimatedMinutes: 60 }), topic('next', { orderIndex: 1 })]
  const result = plan({ topics, dailyMinutes: 45 })
  const long = items(result, 'learn').filter((item) => item.topicId === 'long')
  assert.deepEqual(
    long.map((item) => [item.date, item.minutes, item.part]),
    [
      ['2026-10-21', 45, { number: 1, of: 2 }],
      ['2026-10-22', 15, { number: 2, of: 2 }],
    ]
  )
  // The second day goes on with the next topic: 35 minutes do not fit the 30 that are left, so it is
  // split too, keeping the second part at least 15 minutes.
  const next = items(result, 'learn').filter((item) => item.topicId === 'next')
  assert.deepEqual(next.map((item) => [item.date, item.minutes]), [['2026-10-22', 20], ['2026-10-23', 15]])
})

test('unknown minutes default to 35, and a started topic needs half', () => {
  assert.equal(learnMinutesLeft({ estimatedMinutes: null, learned: false, started: false }), 35)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 0, learned: false, started: false }), 35)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 40, learned: false, started: true }), 20)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 45, learned: false, started: true }), 25)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 45, learned: true, started: true }), 0)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 5, learned: false, started: false }), 10)
})

test('a topic never comes before its unlearned prerequisite', () => {
  const topics = [
    topic('late-skill', { orderIndex: 0, prerequisiteIds: ['basics'] }),
    topic('other', { orderIndex: 1 }),
    topic('basics', { orderIndex: 2 }),
  ]
  assert.deepEqual(learnOrder(topics, { examFirst: false }).map((item) => item.id), ['basics', 'late-skill', 'other'])
  const result = plan({ topics })
  assert.deepEqual(learnDays(result).slice(0, 4), ['basics@2026-10-21', 'late-skill@2026-10-22', 'late-skill@2026-10-23', 'other@2026-10-23'])
})

test('a learned prerequisite holds nothing back, and a cycle still gets planned', () => {
  const topics = [topic('a', { orderIndex: 0, prerequisiteIds: ['done'] }), topic('done', { orderIndex: 1, learned: true })]
  assert.deepEqual(learnOrder(topics, { examFirst: false }).map((item) => item.id), ['a'])
  const cycle = [topic('x', { orderIndex: 0, prerequisiteIds: ['y'] }), topic('y', { orderIndex: 1, prerequisiteIds: ['x'] })]
  assert.deepEqual(learnOrder(cycle, { examFirst: false }).map((item) => item.id).sort(), ['x', 'y'])
  const self = [topic('s', { orderIndex: 0, prerequisiteIds: ['s'] })]
  assert.deepEqual(learnOrder(self, { examFirst: false }).map((item) => item.id), ['s'])
})

test('past-exam topics come first when asked, with their prerequisites before them', () => {
  const topics = [
    topic('a', { orderIndex: 0 }),
    topic('b', { orderIndex: 1, examRelevant: true, prerequisiteIds: ['c'] }),
    topic('c', { orderIndex: 2 }),
    topic('d', { orderIndex: 3, examRelevant: true }),
  ]
  assert.deepEqual(learnOrder(topics, { examFirst: true }).map((item) => item.id), ['c', 'b', 'd', 'a'])
  assert.deepEqual(learnOrder(topics, { examFirst: false }).map((item) => item.id), ['a', 'c', 'b', 'd'])
})

test('the first quiz is the day after the topic is learned', () => {
  const result = plan({ topics: course(2) })
  assert.equal(dayOf(result, 'a', 'learn'), '2026-10-21')
  assert.equal(dayOf(result, 'a', 'quiz'), '2026-10-22')
  // b is split over the 22nd and the 23rd, so its quiz is on the 24th.
  assert.equal(dayOf(result, 'b', 'quiz'), '2026-10-24')
  // Quizzes come before the day's new learning.
  assert.deepEqual(result.days[1].items.map((item) => item.kind), ['quiz', 'learn'])
})

test('a split topic is quizzed the day after its last part', () => {
  const result = plan({ topics: [topic('long', { estimatedMinutes: 60 })], dailyMinutes: 45 })
  assert.equal(dayOf(result, 'long', 'quiz'), '2026-10-23')
})

test('a topic that is learned but never quizzed gets its quiz today, or tomorrow if learned today', () => {
  const quizToday = plan({ topics: [topic('a', { learned: true })] })
  assert.equal(dayOf(quizToday, 'a', 'quiz'), TODAY)
  const quizTomorrow = plan({ topics: [topic('a', { learned: true, learnedToday: true })] })
  assert.equal(dayOf(quizTomorrow, 'a', 'quiz'), '2026-10-22')
})

test('reviews are at the due day; overdue reviews are today and say so', () => {
  const topics = [
    topic('soon', { orderIndex: 0, learned: true, quizzed: true, mastery: 0.6, reviewDueAt: new Date('2026-10-24T09:00:00Z') }),
    topic('late', { orderIndex: 1, learned: true, quizzed: true, mastery: 0.3, reviewDueAt: new Date('2026-10-18T09:00:00Z') }),
  ]
  const result = plan({ topics })
  assert.equal(dayOf(result, 'soon', 'review'), '2026-10-24')
  const late = items(result, 'review').find((item) => item.topicId === 'late')
  assert.equal(late?.date, TODAY)
  assert.equal(late?.note, 'Overdue by 3 days')
  assert.equal(items(result, 'quiz').length, 0)
})

test('reviews that do not fit move to the next day, weakest first', () => {
  // 20 minutes a day: two 10-minute reviews a day. Five are due today.
  const topics = ['a', 'b', 'c', 'd', 'e'].map((name, index) =>
    topic(name, { orderIndex: index, learned: true, quizzed: true, mastery: 0.9 - index * 0.1, reviewDueAt: new Date('2026-10-21T01:00:00Z') })
  )
  const result = plan({ topics, dailyMinutes: 20 })
  const byDay = result.days.slice(0, 3).map((day) => day.items.map((item) => item.topicId))
  assert.deepEqual(byDay, [['e', 'd'], ['c', 'b'], ['a']])
})

test('reviews come before new learning', () => {
  const topics = [
    topic('new', { orderIndex: 0 }),
    topic('old', { orderIndex: 1, learned: true, quizzed: true, mastery: 0.4, reviewDueAt: new Date('2026-10-21T01:00:00Z') }),
  ]
  const result = plan({ topics, dailyMinutes: 45 })
  assert.deepEqual(result.days[0].items.map((item) => item.kind), ['review', 'learn'])
  // 45 - 10 = 35 left: the whole 35-minute topic still fits.
  assert.equal(result.days[0].items[1].minutes, 35)
})

test('a unit with 3 or more topics gets a mock exam the day after it is learned', () => {
  const units = [{ id: 'u1', title: 'Sorting', weekLabel: null, orderIndex: 0 }]
  const result = plan({ topics: course(3, { unitId: 'u1' }), units })
  const mocks = items(result, 'unit_mock')
  assert.equal(mocks.length, 1)
  // c's last part is on the 24th, so the mock is on the 25th (with c's quiz: 45 minutes).
  assert.equal(mocks[0].date, '2026-10-25')
  assert.equal(result.days.find((day) => day.date === '2026-10-25')?.minutes, 45)
  assert.equal(mocks[0].title, 'Mock exam: Sorting')
  assert.deepEqual(mocks[0].topicIds, ['a', 'b', 'c'])
  assert.equal(mocks[0].unitId, 'u1')
})

test('a unit with fewer than 3 topics gets no mock exam, nor one whose mock was already taken', () => {
  const units = [
    { id: 'small', title: 'Small', weekLabel: null, orderIndex: 0 },
    { id: 'big', title: 'Big', weekLabel: null, orderIndex: 1 },
  ]
  const topics = [
    ...course(2, { unitId: 'small' }).map((t) => ({ ...t, id: `s-${t.id}` })),
    ...course(3, { unitId: 'big' }).map((t, index) => ({ ...t, id: `b-${t.id}`, orderIndex: 10 + index })),
  ]
  assert.equal(items(plan({ topics, units }), 'unit_mock').length, 1)
  assert.equal(items(plan({ topics, units, unitMocksDone: ['big'] }), 'unit_mock').length, 0)
})

test('a unit that is already learned gets its mock exam today, one unit a day', () => {
  const units = [
    { id: 'u1', title: 'One', weekLabel: null, orderIndex: 0 },
    { id: 'u2', title: 'Two', weekLabel: null, orderIndex: 1 },
  ]
  const topics = [
    ...course(3, { unitId: 'u1', learned: true, quizzed: true }).map((t) => ({ ...t, id: `x-${t.id}` })),
    ...course(3, { unitId: 'u2', learned: true, quizzed: true }).map((t, index) => ({ ...t, id: `y-${t.id}`, orderIndex: 10 + index })),
  ]
  const mocks = items(plan({ topics, units }), 'unit_mock')
  assert.deepEqual(mocks.map((item) => [item.unitId, item.date]), [
    ['u1', TODAY],
    ['u2', '2026-10-22'],
  ])
})

test('a unit mock exam needs a day with room for it: none on a day shorter than the mock', () => {
  const units = [{ id: 'u1', title: 'One', weekLabel: null, orderIndex: 0 }]
  const topics = [
    ...course(3, { unitId: 'u1', learned: true, quizzed: true }).map((t) => ({ ...t, id: `x-${t.id}` })),
    topic('new', { orderIndex: 20 }),
  ]
  // 20 minutes a day: a 30-minute unit mock would run over every day, so none is planned.
  const short = plan({ topics, units, dailyMinutes: 20 })
  assert.equal(items(short, 'unit_mock').length, 0)
  assert.ok(short.days.every((day) => day.minutes <= 20))
  assert.equal(short.unitMocksSkipped, false)
  assert.equal(dayOf(short, 'new', 'learn'), TODAY)
  // 30 minutes a day: it fits, alone on today.
  const fits = plan({ topics, units, dailyMinutes: 30 })
  assert.deepEqual(fits.days[0].items.map((item) => [item.kind, item.minutes]), [['unit_mock', 30]])
  // Done work counts: with 20 minutes already studied today, it waits for tomorrow.
  const busy = plan({ topics, units, dailyMinutes: 45, doneToday: [{ kind: 'review', topicId: 'x-a' }, { kind: 'review', topicId: 'x-b' }] })
  assert.equal(items(busy, 'unit_mock')[0].date, '2026-10-22')
})

test('a full mock exam longer than the day is alone on its day and marked; one that fits shares it', () => {
  // 45 minutes a day and a 60-minute full mock: nothing else that day, and it is marked as over.
  const short = plan({ topics: course(4), examDate: '2026-11-08', dailyMinutes: 45 })
  const mocks = items(short, 'full_mock')
  assert.equal(mocks.length, 2)
  for (const mock of mocks) {
    const day = short.days.find((entry) => entry.date === mock.date)!
    assert.deepEqual(day.items.map((item) => item.kind), ['full_mock'])
    assert.equal(mock.overBudget, true)
    assert.equal(day.minutes, 60)
  }
  // 90 minutes a day: it fits, is not marked, and the day holds other work up to 90.
  const roomy = plan({ topics: course(4), examDate: '2026-11-08', dailyMinutes: 90 })
  for (const mock of items(roomy, 'full_mock')) {
    assert.ok(!mock.overBudget)
    assert.ok(roomy.days.find((entry) => entry.date === mock.date)!.minutes <= 90)
  }
  assert.ok(roomy.days.some((day) => day.items.some((item) => item.kind === 'full_mock') && day.items.length > 1))
})

test('with an exam date the plan runs to the exam day', () => {
  const result = plan({ topics: course(2), examDate: '2026-11-04' })
  assert.equal(result.mode, 'exam')
  assert.equal(result.daysToExam, 14)
  assert.equal(result.days.length, 15)
  assert.equal(result.days[14].date, '2026-11-04')
  assert.ok(result.days[14].isExamDay)
  assert.equal(result.days.filter((day) => day.isExamDay).length, 1)
})

test('two full mock exams in the final week, the second at least 2 days before the exam', () => {
  const result = plan({ topics: course(2), examDate: '2026-11-04' })
  const mocks = items(result, 'full_mock')
  // b's last part is on the 23rd and its quiz on the 24th, 11 days before the exam: the first full mock is the day after.
  assert.deepEqual(mocks.map((item) => item.date), ['2026-10-25', '2026-11-02'])
  assert.ok(daysBetween(mocks[1].date, '2026-11-04') >= 2)
  assert.ok(mocks.every((item) => item.minutes === 60 && item.title === 'Full mock exam'))
  assert.equal(result.mockNote, null)
})

test('one full mock is planned when one was already taken in the final week', () => {
  const result = plan({ topics: course(2), examDate: '2026-11-04', fullMocksDoneInFinalWeek: 1 })
  assert.deepEqual(items(result, 'full_mock').map((item) => item.date), ['2026-11-02'])
  assert.equal(items(plan({ topics: course(2), examDate: '2026-11-04', fullMocksDoneInFinalWeek: 2 }), 'full_mock').length, 0)
})

test('close to the exam the mocks move up, and the plan says when there is no room', () => {
  // Everything is learned, so time is not short and both mocks are kept as far as they fit.
  const done = course(2, { learned: true, quizzed: true, mastery: 0.6 })
  const three = plan({ topics: done, examDate: '2026-10-24' })
  assert.deepEqual(items(three, 'full_mock').map((item) => item.date), ['2026-10-21', '2026-10-22'])
  const two = plan({ topics: done, examDate: '2026-10-23' })
  assert.deepEqual(items(two, 'full_mock').map((item) => item.date), ['2026-10-21'])
  assert.match(two.mockNote ?? '', /only one full mock/)
  const one = plan({ topics: done, examDate: '2026-10-22' })
  assert.equal(items(one, 'full_mock').length, 0)
  assert.match(one.mockNote ?? '', /less than 2 days/)
})

test('when time is short, the earlier full mock goes before any topic is left out, and learning gets the time', () => {
  // 7 days to the exam, 30 minutes a day, 50-minute topics: with two mocks only one topic fits; with one, two do.
  const topics = Array.from({ length: 6 }, (_, index) => topic(`t${index}`, { orderIndex: index, estimatedMinutes: 50 }))
  const result = plan({ topics, examDate: '2026-10-28', dailyMinutes: 30 })
  const mocks = items(result, 'full_mock')
  assert.equal(mocks.length, 1)
  assert.equal(mocks[0].date, '2026-10-26') // 2 days before the exam
  // 60 minutes on a 30-minute day: alone on its day and marked.
  assert.equal(mocks[0].overBudget, true)
  assert.ok(result.fullMocksReduced)
  assert.match(result.mockNote ?? '', /only one full mock exam is planned/)
  const learned = learnTopics(result)
  assert.equal(learned.size, 2)
  // Still short: the rest is listed, and the message says only one mock is planned.
  assert.ok(result.short)
  assert.match(result.shortMessage ?? '', /Only one full mock exam is planned/)
  assert.equal(result.notScheduled?.topics.length, 4)
  // Nothing else changed the order: course order without past exams.
  assert.deepEqual([...learned], ['t0', 't1'])
})

test('with one full mock already taken in the final week, short time does not drop another', () => {
  const topics = Array.from({ length: 6 }, (_, index) => topic(`t${index}`, { orderIndex: index, estimatedMinutes: 50 }))
  const result = plan({ topics, examDate: '2026-10-27', dailyMinutes: 30, fullMocksDoneInFinalWeek: 1 })
  assert.equal(items(result, 'full_mock').length, 1)
  assert.equal(result.fullMocksReduced, false)
})

test('unit mocks go first, then the earlier full mock; neither is dropped when everything fits', () => {
  const units = [{ id: 'u', title: 'U', weekLabel: null, orderIndex: 0 }]
  // 3 topics, 7 days, 60 minutes a day: all mocks fit.
  const fits = plan({ topics: course(3, { unitId: 'u', estimatedMinutes: 45 }), units, examDate: '2026-10-28', dailyMinutes: 60 })
  assert.equal(items(fits, 'full_mock').length, 2)
  assert.equal(items(fits, 'unit_mock').length, 1)
  assert.equal(fits.fullMocksReduced, false)
  assert.equal(fits.unitMocksSkipped, false)
  // 4 topics, 7 days: both mock kinds crowd learning, so the unit mock and the earlier full mock give way and everything fits.
  const tight = plan({ topics: course(4, { unitId: 'u', estimatedMinutes: 45 }), units, examDate: '2026-10-28', dailyMinutes: 60 })
  assert.equal(items(tight, 'unit_mock').length, 0)
  assert.equal(items(tight, 'full_mock').length, 1)
  assert.equal(learnTopics(tight).size, 4)
  assert.ok(tight.unitMocksSkipped && tight.fullMocksReduced)
  assert.equal(tight.short, false)
  assert.equal(tight.notScheduled, null)
})

test('a tiny window keeps one full mock the day before the exam, and that day is not a review day', () => {
  const topics = [topic('a', { orderIndex: 0 }), topic('b', { orderIndex: 1, estimatedMinutes: 600 })]
  const result = plan({ topics, examDate: '2026-10-22', dailyMinutes: 30 })
  const mocks = items(result, 'full_mock')
  assert.deepEqual(mocks.map((item) => item.date), ['2026-10-21'])
  assert.ok(!result.days[0].isFinalReview)
  assert.ok(result.days[1].isExamDay)
  // Exam today: nothing to place.
  assert.equal(items(plan({ topics, examDate: TODAY }), 'full_mock').length, 0)
})

test('the last 2 days hold only reviews of the weakest topics', () => {
  const topics = [
    topic('strong', { orderIndex: 0, learned: true, quizzed: true, mastery: 0.95, reviewDueAt: new Date('2026-11-03T10:00:00Z') }),
    topic('weak', { orderIndex: 1, learned: true, quizzed: true, mastery: 0.2 }),
    topic('mid', { orderIndex: 2, learned: true, quizzed: true, mastery: 0.5 }),
  ]
  const result = plan({ topics, examDate: '2026-11-04', dailyMinutes: 30 })
  const eve = result.days.find((day) => day.date === '2026-11-03')!
  const examDay = result.days.find((day) => day.date === '2026-11-04')!
  assert.ok(eve.isFinalReview && examDay.isFinalReview)
  assert.ok(eve.items.every((item) => item.kind === 'review'))
  assert.deepEqual(eve.items.map((item) => item.topicId), ['weak', 'mid', 'strong'])
  // 30 minutes a day is 3 reviews; the exam day is lighter.
  assert.deepEqual(examDay.items.map((item) => item.topicId), ['weak', 'mid'])
  assert.ok(eve.items[0].note?.includes('weakest'))
})

test('nothing but reviews is planned in the last 2 days, even with topics left to learn', () => {
  const topics = [...course(2, { learned: true, quizzed: true, mastery: 0.4 }), topic('big', { orderIndex: 9, estimatedMinutes: 600 })]
  const result = plan({ topics, examDate: '2026-10-25' })
  const last = result.days.slice(-2)
  assert.ok(last.every((day) => day.items.every((item) => item.kind === 'review')))
})

test('an exam today is a single exam day', () => {
  const result = plan({ topics: course(2, { learned: true, quizzed: true, mastery: 0.5 }), examDate: TODAY })
  assert.equal(result.days.length, 1)
  assert.ok(result.days[0].isExamDay && result.days[0].isToday)
})

test('when time is short the plan says so, puts past-exam topics first and lists what is not scheduled', () => {
  const topics = [
    topic('intro', { orderIndex: 0 }),
    topic('mid', { orderIndex: 1 }),
    topic('hard', { orderIndex: 2, examRelevant: true }),
    topic('tricky', { orderIndex: 3, examRelevant: true }),
    topic('extra', { orderIndex: 4 }),
  ]
  const result = plan({ topics, examDate: '2026-10-27', dailyMinutes: 40 })
  assert.ok(result.short)
  assert.match(result.shortMessage ?? '', /^Time is short\./)
  assert.match(result.shortMessage ?? '', /past exams come first/)
  assert.equal(result.notScheduled?.reason, 'short')
  const scheduled = new Set(items(result, 'learn').map((item) => item.topicId))
  const notScheduled = result.notScheduled?.topics.map((entry) => entry.id) ?? []
  // Never silently dropped: every unlearned topic is scheduled or listed.
  assert.deepEqual([...scheduled, ...notScheduled].sort(), ['extra', 'hard', 'intro', 'mid', 'tricky'])
  assert.ok(notScheduled.length > 0)
  assert.ok(scheduled.has('hard') && scheduled.has('tricky'))
  const order = items(result, 'learn').map((item) => item.topicId)
  assert.ok(order.indexOf('hard') < order.indexOf('tricky'))
  assert.ok(!notScheduled.includes('hard') && !notScheduled.includes('tricky'))
})

test('without past exams the short message says the order is course order', () => {
  const result = plan({ topics: course(8), examDate: '2026-10-26', dailyMinutes: 40 })
  assert.ok(result.short)
  assert.match(result.shortMessage ?? '', /course order/)
  assert.doesNotMatch(result.shortMessage ?? '', /past exams/)
})

test('when it all fits there is no warning and nothing is left out', () => {
  const result = plan({ topics: course(3), examDate: '2026-11-18' })
  assert.equal(result.short, false)
  assert.equal(result.shortMessage, null)
  assert.equal(result.notScheduled, null)
  assert.equal(learnTopics(result).size, 3)
})

test('unit mock exams are dropped before topics are, with a notice rather than a warning', () => {
  const units = [{ id: 'u1', title: 'One', weekLabel: null, orderIndex: 0 }]
  // 3 topics in a unit and 2 outside it, 40 minutes each, 40 minutes a day, 9 days to the exam. With the
  // unit's mock exam (30 minutes) in the way the last topic no longer fits; without it, everything does.
  const topics = [...course(3, { unitId: 'u1', estimatedMinutes: 40 }), topic('d', { orderIndex: 3, estimatedMinutes: 40 }), topic('e', { orderIndex: 4, estimatedMinutes: 40 })]
  const result = plan({ topics, units, examDate: '2026-10-30', dailyMinutes: 40, fullMocksDoneInFinalWeek: 2 })
  assert.equal(items(result, 'unit_mock').length, 0)
  assert.equal(learnTopics(result).size, 5)
  assert.equal(result.unitMocksSkipped, true)
  assert.equal(result.short, false)
  assert.equal(result.shortMessage, null)
  assert.equal(result.notScheduled, null)
  // With more days the mock exam is kept.
  const roomy = plan({ topics, units, examDate: '2026-11-04', dailyMinutes: 40, fullMocksDoneInFinalWeek: 2 })
  assert.equal(items(roomy, 'unit_mock').length, 1)
  assert.equal(roomy.unitMocksSkipped, false)
})

test('a topic that would only be half taught is not started: it is listed as not scheduled', () => {
  // Two learning days of 30 minutes (the exam is 3 days away); each topic needs 40, so only one can be finished.
  const topics = [topic('a', { orderIndex: 0, estimatedMinutes: 40 }), topic('b', { orderIndex: 1, estimatedMinutes: 40 })]
  const result = plan({ topics, examDate: '2026-10-24', dailyMinutes: 30, fullMocksDoneInFinalWeek: 2 })
  const parts = items(result, 'learn')
  assert.ok(parts.every((item) => item.topicId === 'a'))
  assert.deepEqual(parts.map((item) => item.minutes), [25, 15])
  assert.deepEqual(result.notScheduled?.topics.map((entry) => entry.id), ['b'])
  assert.ok(result.short)
})

test('without an exam date, topics beyond the two weeks are "later", not "short"', () => {
  const result = plan({ topics: course(20) })
  assert.equal(result.short, false)
  assert.equal(result.shortMessage, null)
  assert.equal(result.notScheduled?.reason, 'later')
  assert.equal(learnTopics(result).size + (result.notScheduled?.topics.length ?? 0), 20)
})

test('what was done today is ticked, and its time comes out of today', () => {
  const topics = [
    topic('a', { orderIndex: 0, learned: true, learnedToday: true }),
    topic('b', { orderIndex: 1 }),
    topic('c', { orderIndex: 2 }),
  ]
  const result = plan({ topics, doneToday: [{ kind: 'learn', topicId: 'a' }] })
  const today = result.days[0]
  assert.equal(today.items[0].done, true)
  assert.equal(today.items[0].kind, 'learn')
  assert.equal(today.items[0].topicId, 'a')
  assert.equal(today.doneMinutes, 35)
  // 45 - 35 = 10 minutes left today: too little for a learn block, so b starts tomorrow.
  assert.deepEqual(today.items.filter((item) => !item.done).map((item) => item.kind), [])
  assert.equal(dayOf(result, 'b', 'learn'), '2026-10-22')
  assert.equal(dayOf(result, 'a', 'quiz'), '2026-10-22')
})

test('done quizzes, reviews and mock exams show too, and unknown topics are skipped', () => {
  const topics = [topic('a', { learned: true, quizzed: true, mastery: 0.8, reviewDueAt: new Date('2026-10-28T00:00:00Z') })]
  const result = plan({
    topics,
    doneToday: [
      { kind: 'quiz', topicId: 'a' },
      { kind: 'review', topicId: 'a' },
      { kind: 'mock', examId: 'e1', name: 'Mock exam 3', minutes: 45 },
      { kind: 'review', topicId: 'gone' },
    ],
  })
  const done = result.days[0].items.filter((item) => item.done)
  assert.equal(done.length, 3)
  assert.deepEqual(done.map((item) => item.kind).sort(), ['full_mock', 'quiz', 'review'])
  assert.equal(todayItems(result).length, result.days[0].items.length)
})

test('item ids are unique, and the plan is deterministic and leaves its input alone', () => {
  const topics = course(6)
  const before = JSON.stringify(topics)
  const input: PlanInput = {
    now: NOW,
    timeZone: 'America/New_York',
    examDate: '2026-11-10',
    dailyMinutes: 60,
    topics,
    units: [{ id: 'u', title: 'U', weekLabel: null, orderIndex: 0 }],
    unitMocksDone: [],
    fullMocksDoneInFinalWeek: 0,
    doneToday: [],
  }
  const first = buildPlan(input)
  const second = buildPlan(input)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(topics), before)
  const ids = first.days.flatMap((day) => day.items.map((item) => item.id))
  assert.equal(new Set(ids).size, ids.length)
})

test('a very distant exam is planned for the first stretch only, and the rest is "later"', () => {
  const result = plan({ topics: course(200), examDate: '2027-09-01', dailyMinutes: 45 })
  assert.equal(result.days.length, 120)
  assert.equal(result.short, false)
  assert.equal(result.notScheduled?.reason, 'later')
})

test('daily minutes are kept within sane limits', () => {
  assert.equal(plan({ topics: course(1), dailyMinutes: 0 }).dailyMinutes, 10)
  assert.equal(plan({ topics: course(1), dailyMinutes: 99999 }).dailyMinutes, 600)
  assert.equal(plan({ topics: course(1), dailyMinutes: Number.NaN }).dailyMinutes, 45)
})

test('everything learned and quizzed leaves an empty rolling plan', () => {
  const result = plan({ topics: course(3, { learned: true, quizzed: true, mastery: 0.9 }) })
  assert.equal(result.status, 'ready')
  assert.equal(items(result).length, 0)
  assert.equal(result.remaining.topics, 0)
})

test('remaining work is reported', () => {
  const result = plan({ topics: [...course(2), topic('z', { orderIndex: 5, learned: true })] })
  assert.deepEqual(result.remaining, { topics: 2, minutes: 70 })
})

// A small seeded generator, so the same cases run every time.
function rng(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

test('invariants hold for many generated courses', () => {
  const random = rng(7)
  // Work done today comes from its own generator, so the courses are the same ones as before it was added.
  const randomDone = rng(11)
  for (let round = 0; round < 150; round += 1) {
    const count = 1 + Math.floor(random() * 14)
    const units = [0, 1, 2].map((index) => ({ id: `u${index}`, title: `Unit ${index}`, weekLabel: null, orderIndex: index }))
    const topics = Array.from({ length: count }, (_, index) =>
      topic(`t${index}`, {
        orderIndex: index,
        unitId: random() < 0.8 ? `u${Math.floor((index * 3) / count)}` : null,
        estimatedMinutes: random() < 0.2 ? null : 10 + Math.floor(random() * 90),
        examRelevant: random() < 0.3,
        learned: random() < 0.25,
        started: random() < 0.2,
        quizzed: random() < 0.3,
        mastery: random() < 0.7 ? random() : null,
        prerequisiteIds: index > 0 && random() < 0.4 ? [`t${Math.floor(random() * index)}`] : [],
        reviewDueAt: random() < 0.3 ? new Date(NOW.getTime() + (random() * 20 - 5) * 86_400_000) : null,
      })
    )
    const daily = 15 + Math.floor(random() * 120)
    const examDate = random() < 0.7 ? addDays(TODAY, Math.floor(random() * 40)) : null
    const doneToday: DoneToday[] = []
    const quizzedTopic = topics.find((entry) => entry.learned && entry.quizzed)
    if (quizzedTopic && randomDone() < 0.3) doneToday.push({ kind: 'review', topicId: quizzedTopic.id })
    if (randomDone() < 0.2) doneToday.push({ kind: 'mock', examId: 'e', name: 'Mock exam', minutes: 10 + Math.floor(randomDone() * 60) })
    const result = plan({ topics, units, examDate, dailyMinutes: daily, doneToday })
    const label = `round ${round} (${count} topics, ${daily} min, exam ${examDate}, ${doneToday.length} done today)`

    const ids = items(result).map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, `unique ids, ${label}`)

    const learnTopics = new Set(items(result, 'learn').map((item) => item.topicId))
    const listed = new Set(
      [...(result.notScheduled?.topics ?? []), ...(result.tooLongForDay?.topics ?? []), ...(result.tooLongForDay?.dependents ?? [])].map((entry) => entry.id)
    )
    // A topic is too long only when no split into parts of 15+ minutes fits the day, and what is too
    // long never holds up the topics after it: those are not short of time on its account.
    for (const entry of result.tooLongForDay?.topics ?? []) {
      const minutes = learnMinutesLeft(topics.find((t) => t.id === entry.id)!)
      assert.ok(minutes > daily, `${entry.id} (${minutes} min) is too long for ${daily}, ${label}`)
      assert.ok(!fitsInDays(minutes, daily), label)
    }
    // Starting a topic never makes it too long: if the whole topic fits, so does the half that is left.
    for (const entry of result.tooLongForDay?.topics ?? []) {
      const original = topics.find((t) => t.id === entry.id)!
      assert.ok(!original.started || !fitsInDays(learnMinutesLeft({ ...original, started: false }), daily), `${entry.id} is too long only because it is started, ${label}`)
    }
    if (result.tooLongForDay && !result.notScheduled) assert.equal(result.short, false, label)
    for (const entry of topics.filter((item) => !item.learned)) {
      assert.ok(learnTopics.has(entry.id) !== listed.has(entry.id), `${entry.id} is scheduled or listed, never both or neither, ${label}`)
    }
    for (const entry of topics.filter((item) => item.learned)) {
      assert.ok(!learnTopics.has(entry.id) && !listed.has(entry.id), `learned topics are not planned again, ${label}`)
    }

    // Prerequisites are learned first (on an earlier day, or the same day earlier in the order).
    const firstDay = new Map<string, string>()
    for (const item of items(result, 'learn')) if (!firstDay.has(item.topicId as string)) firstDay.set(item.topicId as string, item.date)
    for (const entry of topics) {
      for (const need of entry.prerequisiteIds) {
        if (firstDay.has(entry.id) && firstDay.has(need)) {
          assert.ok((firstDay.get(need) as string) <= (firstDay.get(entry.id) as string), `${need} before ${entry.id}, ${label}`)
        }
        if (firstDay.has(entry.id) && !topics.find((item) => item.id === need)?.learned) {
          assert.ok(firstDay.has(need), `${entry.id} is not planned without its prerequisite ${need}, ${label}`)
        }
      }
    }

    for (const day of result.days) {
      const planned = day.items.filter((item) => !item.done)
      if (day.isFinalReview) {
        assert.ok(planned.every((item) => item.kind === 'review'), `final days hold reviews only, ${label}`)
      }
      // The cap: no day holds more than the daily minutes, today's finished work included. The one
      // exception is a full mock exam longer than the day's time, which is alone on its day and marked.
      const over = planned.filter((item) => item.overBudget)
      if (over.length > 0) {
        assert.deepEqual(planned.map((item) => item.kind), ['full_mock'], `a marked mock is alone on ${day.date}, ${label}`)
        assert.ok(over[0].minutes > daily - day.doneMinutes, `${day.date}: a marked mock is longer than the day's time, ${label}`)
      } else {
        assert.ok(day.minutes === 0 || day.minutes + day.doneMinutes <= daily, `${day.date} holds ${day.minutes} + ${day.doneMinutes} done minutes, ${label}`)
      }
      assert.ok(planned.every((item) => !item.overBudget || item.kind === 'full_mock'), `only full mocks are marked, ${label}`)
      // Mixed practice never repeats a set on one day.
      const sets = planned.filter((item) => item.kind === 'mixed').map((item) => [...item.topicIds].sort().join())
      assert.equal(new Set(sets).size, sets.length, `${day.date} repeats a mixed practice set, ${label}`)
      // Learning parts are never scraps.
      // Every part but the last is at least 15 minutes; the last at least 5.
      for (const item of planned.filter((entry) => entry.kind === 'learn' && entry.part)) {
        assert.ok(item.minutes >= (item.part!.number < item.part!.of ? 15 : 5), `learn part of ${item.minutes} minutes, ${label}`)
      }
      // Quizzes come after the topic's learning.
      for (const item of day.items.filter((entry) => entry.kind === 'quiz' && topics.find((t) => t.id === entry.topicId)?.learned === false)) {
        const last = items(result, 'learn').filter((entry) => entry.topicId === item.topicId).map((entry) => entry.date).sort().pop()
        assert.ok(last !== undefined && last < item.date, `quiz after learning, ${label}`)
      }
    }
    if (examDate) {
      const mocks = items(result, 'full_mock').filter((item) => !item.done)
      // Two days before the exam or earlier; one day before only in a window too small for that.
      if (mocks.length > 0) assert.ok(daysBetween(mocks[mocks.length - 1].date, examDate) >= (daysBetween(TODAY, examDate) >= 2 ? 2 : 1), `last full mock 2+ days before, ${label}`)
      // A first full mock moved up after learning comes after every first quiz, never on or before one.
      const early = mocks.find((item) => item.note?.startsWith('A first full practice'))
      if (early) {
        for (const quiz of items(result, 'quiz').filter((item) => !item.done)) assert.ok(quiz.date < early.date, `first full mock after the ${quiz.topicId} quiz, ${label}`)
      }
      // A unit mock exam is not before its topics' first quizzes in the plan.
      for (const mock of items(result, 'unit_mock')) {
        for (const quiz of items(result, 'quiz').filter((item) => mock.topicIds.includes(item.topicId as string))) {
          assert.ok(quiz.date <= mock.date, `unit mock after the ${quiz.topicId} quiz, ${label}`)
        }
      }
      // No due review is lost silently. A scheduled review due before the final days is in the plan on
      // or after its day, or listed in reviewsNotScheduled. A suggested (projected) review is not a
      // promise: it may go unplanned, and it is never reported.
      const reported = new Set((result.reviewsNotScheduled ?? []).map((entry) => entry.id))
      const finalStart = addDays(examDate, -1)
      const reviewedFrom = (id: string, from: string) => items(result, 'review').some((item) => item.topicId === id && !item.done && item.date >= from)
      for (const entry of topics.filter((t) => t.reviewDueAt)) {
        const due = localDay(entry.reviewDueAt as Date, 'UTC')
        const from = due < TODAY ? TODAY : due
        if (due <= examDate) assert.ok(reviewedFrom(entry.id, from) || reported.has(entry.id), `${entry.id}'s review due ${due} is planned or reported, ${label}`)
      }
      // Only topics with a real due date are ever reported: never one that only had a projected review.
      for (const id of reported) {
        const entry = topics.find((t) => t.id === id)
        assert.ok(entry?.reviewDueAt, `${id} is reported but had no review due, ${label}`)
      }
      // A reported review really had no room: no day between the topic's latest learning, quiz or review
      // and the final days could take another, and the reason given is true.
      for (const entry of result.reviewsNotScheduled ?? []) {
        const latest = items(result, 'learn').concat(items(result, 'quiz'), items(result, 'review')).filter((item) => item.topicId === entry.id && !item.done && item.date < finalStart).map((item) => item.date).sort().pop()
        const roomy = result.days.filter(
          (day) => day.date >= (latest ? addDays(latest, 1) : TODAY) && day.date < finalStart && day.minutes + day.doneMinutes + 10 <= daily
        )
        assert.equal(roomy.length, 0, `${entry.id} is reported but ${roomy.map((day) => day.date)} had room, ${label}`)
        if (entry.reason === 'final_limit') assert.ok(result.days.every((day) => day.date >= finalStart || day.date < (latest ? addDays(latest, 1) : TODAY)), `${entry.id}: final_limit with earlier days, ${label}`)
      }
      // On a final day a suggested (projected) review never takes the place of a weaker learned topic's.
      const finalReviewed = new Set(result.days.filter((day) => day.isFinalReview).flatMap((day) => day.items).filter((item) => item.kind === 'review').map((item) => item.topicId))
      for (const day of result.days.filter((entry) => entry.isFinalReview)) {
        for (const item of day.items.filter((entry) => entry.kind === 'review' && entry.projected)) {
          for (const weaker of topics.filter((t) => t.learned && (t.mastery ?? 0) < (item.mastery ?? 0))) {
            assert.ok(finalReviewed.has(weaker.id), `${weaker.id} has no final review but ${item.topicId} (projected) does, ${label}`)
          }
        }
      }
      for (const entry of result.tooLongForDay?.dependents ?? []) {
        const needs = topics.find((t) => t.id === entry.id)?.prerequisiteIds ?? []
        assert.ok(needs.some((id) => listed.has(id)), `${entry.id} waits on a too-long topic, ${label}`)
      }
      assert.ok(result.days.every((day) => day.date <= examDate), label)
    } else {
      assert.equal(result.short, false, label)
    }
  }
})

// ---------------------------------------------------------------------------------------
// The revision phase: projected reviews, mixed practice, the first full mock

const longCourse = () => course(8, { estimatedMinutes: 40 }).map((entry, index) => ({ ...entry, examRelevant: index === 3 || index === 7 }))
const longPlan = (overrides: Partial<PlanInput> = {}) =>
  plan({ topics: longCourse(), examDate: '2026-11-14', dailyMinutes: 60, ...overrides })
const lastLearnDay = (result: Plan) => items(result, 'learn').map((item) => item.date).sort().pop() as string

test('a long window has no more than one rest day in any 7 between the end of learning and the exam', () => {
  const result = longPlan()
  const end = lastLearnDay(result)
  const after = result.days.filter((day) => day.date > end && day.date < '2026-11-14')
  assert.ok(after.length >= 14, `${after.length} days of revision`)
  for (let start = 0; start + 7 <= after.length; start += 1) {
    const window = after.slice(start, start + 7)
    const rests = window.filter((day) => day.items.length === 0).length
    assert.ok(rests <= 1, `${window[0].date}: ${rests} rest days in 7`)
  }
  // The run keeps its rest days: some days hold nothing but a review.
  assert.ok(after.some((day) => day.items.every((item) => item.kind === 'review')))
  // The final days are the weakest-topic reviews, never mixed practice.
  assert.ok(result.days.slice(-2).every((day) => day.items.every((item) => item.kind === 'review')))
})

test('every learned topic is reviewed after its quiz and before the exam', () => {
  const result = longPlan()
  for (const entry of longCourse()) {
    const quiz = items(result, 'quiz').find((item) => item.topicId === entry.id)?.date as string
    assert.ok(quiz, `${entry.id} has a quiz`)
    const reviews = items(result, 'review').filter((item) => item.topicId === entry.id && item.date > quiz && item.date < '2026-11-14')
    assert.ok(reviews.length >= 1, `${entry.id} is reviewed after its quiz`)
  }
})

test('a topic\'s reviews follow increasing intervals', () => {
  // A long window: from the quiz, 7 days (mastery 0.6 is assumed), then 14, then 14 again.
  const long = plan({ topics: course(2, { estimatedMinutes: 30 }), examDate: '2026-12-31', dailyMinutes: 60 })
  for (const id of ['a', 'b']) {
    const dates = [items(long, 'quiz').find((item) => item.topicId === id)!.date, ...items(long, 'review').filter((item) => item.topicId === id && item.projected).map((item) => item.date)]
    const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date))
    assert.ok(gaps.length >= 3, `gaps ${gaps}`)
    // Never shorter than the step before (a day of slack where a day was full), except the last review, pulled in to the deadline.
    for (let index = 1; index < gaps.length - 1; index += 1) assert.ok(gaps[index] >= gaps[index - 1], `gaps ${gaps}`)
    assert.ok(gaps[1] > gaps[0] - 2, `gaps ${gaps}`)
  }
})

test('reviews climb the app\'s interval ladder from the mastery the topic has', () => {
  // Quizzed with mastery 0.2 (a 1-day step) and due today: then 3, 7 and 14 days.
  const weak = topic('weak', { learned: true, quizzed: true, mastery: 0.2, reviewDueAt: new Date('2026-10-21T01:00:00Z') })
  const result = plan({ topics: [weak], examDate: '2026-12-31', dailyMinutes: 60 })
  const dates = items(result, 'review').filter((item) => item.date < '2026-12-29').map((item) => item.date)
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date))
  assert.deepEqual(gaps.slice(0, 3), [3, 7, 14])
  assert.equal(items(result, 'review')[0].projected, false) // the real date is not a projection
  assert.ok(items(result, 'review').filter((item) => item.projected).length >= 3)
})

test('a real review date wins: nothing is projected before it', () => {
  const real = topic('real', { learned: true, quizzed: true, mastery: 0.5, reviewDueAt: new Date('2026-10-30T10:00:00Z') })
  const result = plan({ topics: [real], examDate: '2026-11-30', dailyMinutes: 60 })
  const reviews = items(result, 'review').filter((item) => item.date < '2026-11-28')
  assert.equal(reviews[0].date, '2026-10-30')
  assert.equal(reviews[0].projected, false)
  assert.ok(reviews.length >= 2)
  assert.ok(reviews.slice(1).every((item) => item.projected && item.date > '2026-10-30'))
})

test('a topic not yet quizzed is projected from mastery 0.6: a week after its quiz', () => {
  const result = plan({ topics: course(1, { estimatedMinutes: 30 }), examDate: '2026-12-31', dailyMinutes: 60 })
  const quiz = items(result, 'quiz')[0].date
  const first = items(result, 'review').find((item) => item.projected)!
  assert.equal(daysBetween(quiz, first.date), 7)
})

test('without an exam date reviews are projected inside the 14 days only, and nothing is mixed', () => {
  const result = plan({ topics: course(1, { estimatedMinutes: 30 }) })
  assert.ok(items(result, 'review').length >= 1)
  assert.ok(items(result, 'review').every((item) => item.projected && item.date <= '2026-11-03'))
  assert.equal(items(plan({ topics: longCourse() }), 'mixed').length, 0)
})

test('free time after learning goes to mixed practice on 2-3 topics, weakest and past-exam topics first', () => {
  const result = longPlan()
  const mixed = items(result, 'mixed')
  assert.ok(mixed.length >= 10)
  assert.ok(mixed.every((item) => item.topicIds.length >= 2 && item.topicIds.length <= 3))
  assert.ok(mixed.every((item) => item.minutes >= 15 && item.minutes <= 30))
  assert.ok(mixed.every((item) => item.title.startsWith('Mixed practice: ')))
  // No day holds more than the daily minutes (a 60-minute mock fills a 60-minute day exactly).
  for (const day of result.days) assert.ok(day.minutes <= 60, `${day.date} holds ${day.minutes}`)
  // The topics on past exams (d, h) come up at least as often as the others, and the trios rotate.
  const uses = new Map<string, number>()
  for (const item of mixed) for (const id of item.topicIds) uses.set(id, (uses.get(id) ?? 0) + 1)
  const relevant = Math.min(uses.get('d') ?? 0, uses.get('h') ?? 0)
  const others = Math.max(...['a', 'b', 'c', 'e', 'f', 'g'].map((id) => uses.get(id) ?? 0))
  assert.ok(relevant >= others - 1, `d/h ${relevant}, others ${others}`)
  assert.ok(new Set(mixed.map((item) => item.topicIds.join())).size >= 4)
})

test('no mixed practice while learning is going on, on the final days, or when time is short', () => {
  const result = longPlan()
  const end = lastLearnDay(result)
  assert.ok(items(result, 'mixed').every((item) => item.date >= end))
  assert.ok(result.days.filter((day) => day.isFinalReview).every((day) => day.items.every((item) => item.kind !== 'mixed')))
  // A single learned topic has nothing to mix with.
  assert.equal(items(plan({ topics: course(1, { learned: true, quizzed: true, mastery: 0.5 }), examDate: '2026-11-14' }), 'mixed').length, 0)
  const short = plan({ topics: course(8, { estimatedMinutes: 60 }), examDate: '2026-10-27', dailyMinutes: 30 })
  assert.equal(items(short, 'mixed').length, 0)
})

test('the first full mock is the day after the last first quiz when 7 or more days remain', () => {
  const result = longPlan()
  const mocks = items(result, 'full_mock')
  assert.equal(mocks.length, 2)
  // The last topic is learned on one day and quizzed the next; the mock follows the quiz, never takes its day.
  const lastQuiz = items(result, 'quiz').map((item) => item.date).sort().pop() as string
  assert.equal(lastQuiz, addDays(lastLearnDay(result), 1))
  assert.equal(mocks[0].date, addDays(lastQuiz, 1))
  assert.equal(mocks[1].date, '2026-11-12') // 2 days before the exam
  // Already learned: today.
  const learned = plan({ topics: course(3, { learned: true, quizzed: true, mastery: 0.6 }), examDate: '2026-11-14' })
  assert.equal(items(learned, 'full_mock')[0].date, TODAY)
})

test('with fewer than 7 days left after learning the first full mock keeps its old place, 5 days before the exam', () => {
  const learned = plan({ topics: course(3, { learned: true, quizzed: true, mastery: 0.6 }), examDate: '2026-10-27' })
  assert.deepEqual(items(learned, 'full_mock').map((item) => item.date), ['2026-10-22', '2026-10-25'])
})

test('the time-is-short message never says "room to learn 0": nothing fits is said as nothing fits', () => {
  // Today's time is already used up (a quiz was done), the exam is in 3 days and every topic is new.
  const topics = course(5, { estimatedMinutes: 35 })
  const spent = plan({
    topics: [...topics, topic('done', { orderIndex: 9, learned: true, started: true, quizzed: true, mastery: 0.5 })],
    examDate: '2026-10-24',
    dailyMinutes: 20,
    doneToday: [{ kind: 'quiz', topicId: 'done' }],
  })
  assert.ok(spent.short)
  const message = spent.shortMessage ?? ''
  assert.doesNotMatch(message, /room to learn 0/)
  assert.doesNotMatch(message, /about 0 minutes/)
  assert.match(message, /^Time is short\./)
  assert.match(message, /5 topics/)
  assert.match(message, /Add study time or move the date/)
})

test('the time-is-short message with some topics fitting names how many and how much', () => {
  const topics = [
    topic('intro', { orderIndex: 0 }),
    topic('mid', { orderIndex: 1 }),
    topic('hard', { orderIndex: 2 }),
    topic('tricky', { orderIndex: 3 }),
    topic('extra', { orderIndex: 4 }),
  ]
  const result = plan({ topics, examDate: '2026-10-27', dailyMinutes: 40 })
  assert.ok(result.short)
  assert.match(result.shortMessage ?? '', /\b[1-4] of the 5 topics left/)
  assert.match(result.shortMessage ?? '', /Add study time or move the date/)
})

// ---------------------------------------------------------------------------------------
// The daily minutes are a hard cap

test('no day runs over: the first full mock follows the last first quiz instead of pushing it out', () => {
  // 6 topics, 45 minutes a day. The 60-minute mock used to take the last quiz's day and push the quiz
  // after it, and quiz days ran to 50 minutes.
  const result = plan({ topics: course(6), examDate: '2026-11-20', dailyMinutes: 45 })
  for (const day of result.days) {
    if (day.items.some((item) => item.overBudget)) continue
    assert.ok(day.minutes <= 45, `${day.date} holds ${day.minutes}`)
  }
  const quizzes = items(result, 'quiz').map((item) => item.date).sort()
  assert.equal(quizzes.length, 6)
  const [first, second] = items(result, 'full_mock')
  assert.equal(first.date, addDays(quizzes[quizzes.length - 1], 1))
  assert.match(first.note ?? '', /first full practice/)
  // 60 minutes on a 45-minute day: alone and marked, and so is the second.
  assert.ok(first.overBudget && second.overBudget)
  assert.deepEqual(result.days.find((day) => day.date === first.date)?.items.map((item) => item.kind), ['full_mock'])
})

test("a topic's last review goes on an earlier day with room, never over the cap on the last day", () => {
  // The day 2 before the exam holds the second full mock (60 of 45 minutes), so it has no room for a review.
  const result = plan({ topics: course(6), examDate: '2026-11-20', dailyMinutes: 45 })
  assert.deepEqual(result.days.find((day) => day.date === '2026-11-18')?.items.map((item) => item.kind), ['full_mock'])
  // Every topic still has a review after its quiz and before the final two days.
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const quiz = dayOf(result, id, 'quiz') as string
    assert.ok(items(result, 'review').some((item) => item.topicId === id && item.date > quiz && item.date < '2026-11-19'), `${id} is reviewed`)
  }
})

test('mixed practice never repeats a set on one day', () => {
  // Three learned topics: only one set of three exists, so a day holds one block (30 minutes), not three copies.
  const three = plan({ topics: course(3, { learned: true, quizzed: true, mastery: 0.5 }), examDate: '2026-11-20', dailyMinutes: 90 })
  for (const day of three.days) assert.ok(day.items.filter((item) => item.kind === 'mixed').length <= 1, day.date)
  assert.ok(items(three, 'mixed').every((item) => item.minutes === 30))
  // Five topics, three much weaker than the rest: the weakest three would win every pick, so the
  // second block of a day takes the topics the first one did not.
  const five = plan({
    topics: course(5, { learned: true, quizzed: true }).map((entry, index) => ({ ...entry, mastery: index < 3 ? 0.1 : 0.95 })),
    examDate: '2026-11-20',
    dailyMinutes: 90,
  })
  const day = five.days.find((entry) => entry.items.filter((item) => item.kind === 'mixed').length >= 2)!
  const mixed = day.items.filter((item) => item.kind === 'mixed')
  assert.deepEqual(mixed.map((item) => item.topicIds), [['a', 'b', 'c'], ['d', 'e']])
})

test('a mock exam done today is credited at the time it took, not a fixed 30 minutes', () => {
  const result = plan({ topics: course(3), dailyMinutes: 60, doneToday: [{ kind: 'mock', examId: 'e1', name: 'Mock exam 1', minutes: 50 }] })
  const today = result.days[0]
  assert.equal(today.doneMinutes, 50)
  // 10 minutes left: too little for a learn part, so learning starts tomorrow.
  assert.equal(today.minutes, 0)
  assert.equal(dayOf(result, 'a', 'learn'), '2026-10-22')
})

test("today's finished work counts against the cap: on the final days, and for the first full mock", () => {
  // The exam is tomorrow, so today is a final review day; 40 of 45 minutes are done, so no more reviews today.
  const learned = course(3, { learned: true, quizzed: true, mastery: 0.5 })
  const eve = plan({
    topics: learned,
    examDate: '2026-10-22',
    doneToday: [
      { kind: 'review', topicId: 'a' },
      { kind: 'review', topicId: 'b' },
      { kind: 'review', topicId: 'c' },
      { kind: 'review', topicId: 'a' },
    ],
  })
  assert.equal(eve.days[0].minutes, 0)
  // 90 minutes a day, everything learned and a 45-minute mock done today: the first full mock (60) does
  // not fit what is left today, so it goes tomorrow rather than over today's time.
  const busy = plan({ topics: learned, examDate: '2026-11-20', dailyMinutes: 90, doneToday: [{ kind: 'mock', examId: 'e', name: 'Unit mock', minutes: 45 }] })
  assert.equal(items(busy, 'full_mock').filter((item) => !item.done)[0].date, '2026-10-22')
  assert.ok(busy.days[0].minutes + busy.days[0].doneMinutes <= 90)
})

test("a unit mock exam comes after its topics' first quizzes, on a day with room", () => {
  // 40 minutes a day: the day of c's quiz cannot also hold the 30-minute unit mock, so the mock waits.
  const units = [{ id: 'u1', title: 'One', weekLabel: null, orderIndex: 0 }]
  const topics = [...course(3, { unitId: 'u1', estimatedMinutes: 40 }), topic('d', { orderIndex: 3, estimatedMinutes: 40 })]
  const result = plan({ topics, units, examDate: '2026-11-20', dailyMinutes: 40 })
  const mock = items(result, 'unit_mock')[0]
  for (const id of ['a', 'b', 'c']) assert.ok((dayOf(result, id, 'quiz') as string) <= mock.date, id)
  assert.ok(result.days.every((day) => day.minutes <= 40 || day.items.some((item) => item.overBudget)))
})

test('a topic that can never fit a day is listed as too long, and the topics after it still get scheduled', () => {
  // 12 minutes a day is under the 15-minute part: a 25-minute topic cannot be split to fit. It used to
  // hold up every later topic for the whole plan.
  const topics = [
    topic('long', { orderIndex: 0, estimatedMinutes: 25 }),
    topic('free', { orderIndex: 1, estimatedMinutes: 10 }),
    topic('after-long', { orderIndex: 2, estimatedMinutes: 10, prerequisiteIds: ['long'] }),
  ]
  for (const examDate of [null, '2026-11-20']) {
    const result = plan({ topics, examDate, dailyMinutes: 12 })
    assert.equal(dayOf(result, 'free', 'learn'), TODAY, `${examDate}`)
    assert.ok(!items(result, 'learn').some((item) => item.topicId === 'long' || item.topicId === 'after-long'))
    assert.deepEqual(result.tooLongForDay, {
      topics: [{ id: 'long', name: 'long' }],
      dependents: [{ id: 'after-long', name: 'after-long' }],
    })
    // Not a matter of time before the exam: no warning, no fallbacks, nothing else listed.
    assert.equal(result.short, false)
    assert.equal(result.notScheduled, null)
    assert.equal(result.unitMocksSkipped || result.fullMocksReduced, false)
  }
  // Twenty minutes a day takes a 25-minute topic as 15 + 10, and 40 splits a 45-minute one into 25 + 20.
  assert.equal(plan({ topics, dailyMinutes: 20 }).tooLongForDay, null)
  assert.equal(plan({ topics: [topic('x', { estimatedMinutes: 45 })], dailyMinutes: 40 }).tooLongForDay, null)
  // A 45-minute topic on 20-minute days is split 15 + 15 + 15, never stuck on a short remainder.
  const thirds = plan({ topics: [topic('x', { estimatedMinutes: 45 })], dailyMinutes: 20 })
  assert.equal(thirds.tooLongForDay, null)
  assert.deepEqual(items(thirds, 'learn').map((item) => item.minutes), [15, 15, 15])
})

test('starting a topic never makes it too long: 45 and 50 minutes on 20-minute days', () => {
  // Started, a 45- or 50-minute topic has 25 left, which cannot split into parts of 15 or more within a
  // 20-minute day. The last part may be as short as 10 (15 + 10), so it is scheduled, and so are its dependents.
  assert.equal(fitsInDays(25, 20), true)
  assert.equal(fitsInDays(20, 17), true) // 15 + 5, the last resort
  assert.equal(fitsInDays(25, 12), false)
  for (const estimatedMinutes of [45, 50]) {
    for (const started of [false, true]) {
      const topics = [
        topic('x', { orderIndex: 0, estimatedMinutes, started }),
        topic('y', { orderIndex: 1, estimatedMinutes: 15, prerequisiteIds: ['x'] }),
      ]
      const result = plan({ topics, examDate: '2026-11-20', dailyMinutes: 20 })
      const label = `${estimatedMinutes} min, started ${started}`
      assert.equal(result.tooLongForDay, null, label)
      assert.ok(learnTopics(result).has('x') && learnTopics(result).has('y'), label)
      const parts = items(result, 'learn').filter((item) => item.topicId === 'x').map((item) => item.minutes)
      assert.ok(parts.every((minutes) => minutes <= 20), `${label}: ${parts}`)
      assert.ok(parts.slice(0, -1).every((minutes) => minutes >= 15) && parts[parts.length - 1] >= 10, `${label}: ${parts}`)
      assert.ok(started || estimatedMinutes !== 45 || parts.every((minutes) => minutes === 15), `${label}: ${parts}`)
    }
  }
  const startedPlan = plan({ topics: [topic('x', { estimatedMinutes: 45, started: true })], dailyMinutes: 20 })
  assert.deepEqual(items(startedPlan, 'learn').map((item) => item.minutes), [15, 10])
})

test("a topic's last review is not booked on a day other reviews already fill, and is never lost silently", () => {
  // 20 minutes a day, exam on the 31st. A is strong and due today; B and C are weak and due on the 28th.
  // A's last review used to be booked on the 28th, where B and C (scheduled, so first) took the day,
  // and it vanished though the 27th was empty.
  const topics = [
    topic('a', { orderIndex: 0, learned: true, quizzed: true, mastery: 0.95, reviewDueAt: new Date('2026-10-21T01:00:00Z') }),
    topic('b', { orderIndex: 1, learned: true, quizzed: true, mastery: 0.3, reviewDueAt: new Date('2026-10-28T09:00:00Z') }),
    topic('c', { orderIndex: 2, learned: true, quizzed: true, mastery: 0.4, reviewDueAt: new Date('2026-10-28T09:00:00Z') }),
  ]
  const result = plan({ topics, examDate: '2026-10-31', dailyMinutes: 20 })
  const aReviews = items(result, 'review').filter((item) => item.topicId === 'a').map((item) => item.date)
  // Its last review is booked on the 27th, the empty day before B and C's; the 28th stays theirs.
  assert.ok(aReviews.includes('2026-10-27'), `a reviewed on ${aReviews}`)
  assert.deepEqual(result.days.find((day) => day.date === '2026-10-28')?.items.map((item) => item.topicId), ['b', 'c'])
  assert.equal(result.reviewsNotScheduled, null)
  assert.ok(result.days.every((day) => day.minutes <= 20 || day.items.every((item) => item.overBudget)))
})

test('reviews due in the final days that do not fit there go to an earlier day with room', () => {
  // 600 minutes a day, exam on the 30th: the day before holds 5 reviews and the exam day 2, but nine
  // topics have a review due on the 29th. The other two used to be reported though the 27th was empty.
  const topics = course(9, { learned: true, quizzed: true }).map((entry, index) => ({
    ...entry,
    mastery: 0.1 + index * 0.05,
    reviewDueAt: new Date('2026-10-29T09:00:00Z'),
  }))
  const result = plan({ topics, examDate: '2026-10-30', dailyMinutes: 600 })
  assert.equal(result.reviewsNotScheduled, null)
  const reviewed = new Set(items(result, 'review').map((item) => item.topicId))
  for (const entry of topics) assert.ok(reviewed.has(entry.id), entry.id)
  assert.ok(result.days.filter((day) => day.date < '2026-10-29').some((day) => day.items.some((item) => item.kind === 'review')))
})

test('a review that cannot be placed says why: no room, or the limit on the last two days', () => {
  // Exam tomorrow: only the day before and the exam day exist, holding 5 and 2 reviews whatever the minutes.
  const topics = course(9, { learned: true, quizzed: true }).map((entry, index) => ({
    ...entry,
    mastery: 0.1 + index * 0.05,
    reviewDueAt: new Date('2026-10-21T09:00:00Z'),
  }))
  const result = plan({ topics, examDate: '2026-10-22', dailyMinutes: 600 })
  assert.deepEqual(result.reviewsNotScheduled?.map((entry) => `${entry.id}:${entry.reason}`), ['h:final_limit', 'i:final_limit'])
  // Tight days: every day before the exam is full, so more study time would help.
  const tight = plan({ topics, examDate: '2026-10-25', dailyMinutes: 20 })
  assert.ok((tight.reviewsNotScheduled ?? []).length > 0)
  assert.ok((tight.reviewsNotScheduled ?? []).every((entry) => entry.reason === 'minutes'))
})

test('on a final day a suggested review of a stronger topic does not take the place of a weaker topic', () => {
  // Exam in 7 days, 20 minutes a day: each final day holds 2 reviews. t0 and t1 are due today; t2 (0.5)
  // is stronger than t3 (0.17), and its suggested review used to take a final slot while t3, a weaker
  // learned topic, was left out. Suggested reviews are now ranked with the other topics by mastery.
  const due = { learned: true, quizzed: true, reviewDueAt: NOW }
  const topics = [
    topic('t0', { orderIndex: 0, mastery: 0.15, ...due }),
    topic('t1', { orderIndex: 1, mastery: 0.16, ...due }),
    topic('t2', { orderIndex: 2, mastery: 0.5, learned: true }),
    topic('t3', { orderIndex: 3, mastery: 0.17, learned: true }),
  ]
  const result = plan({ topics, examDate: '2026-10-28', dailyMinutes: 20 })
  const finals = result.days.filter((day) => day.isFinalReview).flatMap((day) => day.items.filter((item) => item.kind === 'review'))
  assert.ok(finals.length > 0)
  assert.ok(!finals.some((item) => item.topicId === 't2'), 'the stronger topic has no final review while weaker ones wait')
  assert.ok(finals.every((item) => ['t0', 't1', 't3'].includes(item.topicId as string)))
  // With room for a third review it is the weaker t3, not the stronger t2, that gets it.
  const roomy = plan({ topics, examDate: '2026-10-28', dailyMinutes: 30 })
  const roomyFinals = roomy.days.filter((day) => day.isFinalReview).flatMap((day) => day.items.filter((item) => item.kind === 'review')).map((item) => item.topicId)
  assert.ok(roomyFinals.includes('t3'))
})
