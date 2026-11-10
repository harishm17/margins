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
  QUICK_PASS_MINUTES,
  localDay,
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

test('two full mock exams in the final week, the second at least 2 days before the exam', () => {
  const result = plan({ topics: course(2), examDate: '2026-11-04' })
  const mocks = items(result, 'full_mock')
  // b's last part is on the 23rd and its quiz on the 24th, 11 days before the exam: the first full mock is the day after.
  assert.deepEqual(mocks.map((item) => item.date), ['2026-10-25', '2026-11-02'])
  assert.ok(daysBetween(mocks[1].date, '2026-11-04') >= 2)
  assert.ok(mocks.every((item) => item.minutes === 60 && item.title === 'Full mock exam'))
  assert.equal(result.mockNote, null)
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
  // Even with topics left to learn, nothing but reviews is planned in the last 2 days.
  const unlearned = [...course(2, { learned: true, quizzed: true, mastery: 0.4 }), topic('big', { orderIndex: 9, estimatedMinutes: 600 })]
  const crowded = plan({ topics: unlearned, examDate: '2026-10-25' })
  assert.ok(crowded.days.slice(-2).every((day) => day.items.every((item) => item.kind === 'review')))
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

test('daily minutes are kept within sane limits', () => {
  assert.equal(plan({ topics: course(1), dailyMinutes: 0 }).dailyMinutes, 10)
  assert.equal(plan({ topics: course(1), dailyMinutes: 99999 }).dailyMinutes, 600)
  assert.equal(plan({ topics: course(1), dailyMinutes: Number.NaN }).dailyMinutes, 45)
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

// ---------------------------------------------------------------------------------------
// Quick-pass triage (spec 18.8)

const shortCourse = () => [
  topic('intro', { orderIndex: 0 }),
  topic('mid', { orderIndex: 1 }),
  topic('hard', { orderIndex: 2 }),
  topic('tricky', { orderIndex: 3 }),
  topic('extra', { orderIndex: 4 }),
]

test('quick pass shortens the learn block to 20 minutes and re-fits', () => {
  assert.equal(QUICK_PASS_MINUTES, 20)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 60, learned: false, started: false, triage: 'quick' }), 20)
  // A learned topic needs nothing, however it was triaged; a started quick topic is still a 20-minute pass.
  assert.equal(learnMinutesLeft({ estimatedMinutes: 60, learned: true, started: false, triage: 'quick' }), 0)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 60, learned: false, started: true, triage: 'quick' }), 20)
  assert.equal(learnMinutesLeft({ estimatedMinutes: 60, learned: false, started: false, triage: null }), 60)

  const before = plan({ topics: shortCourse(), examDate: '2026-10-30', dailyMinutes: 45 })
  assert.ok(before.short)
  const left = before.notScheduled?.topics.map((entry) => entry.id) ?? []
  assert.ok(left.length > 0)

  // The student takes a quick pass on every topic that did not fit: the plan is laid out again with 20 minutes for each.
  const after = plan({ topics: shortCourse().map((entry) => (left.includes(entry.id) ? { ...entry, triage: 'quick' as const } : entry)), examDate: '2026-10-30', dailyMinutes: 45 })
  const quick = items(after, 'learn').filter((item) => left.includes(item.topicId ?? ''))
  assert.ok(quick.length > 0)
  assert.ok(quick.every((item) => item.minutes === 20))
  assert.ok((after.notScheduled?.topics.length ?? 0) < left.length)
  const placed = new Set(items(after, 'learn').map((item) => item.topicId))
  assert.ok(left.some((id) => placed.has(id)))
})
