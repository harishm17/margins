/**
 * The Review page's progress (spec §10) against a real, migrated Postgres (DATABASE_URL): unassisted
 * accuracy by week, calibration, the share of answers with help, and this week's focus. Skipped when no
 * database with the evidence_events table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let progress: typeof import('./progress')
let evidence: typeof import('@/lib/learning/evidence')
let available = false

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const ZONE = 'UTC'
// A Wednesday; the week runs from Monday 2026-10-26.
const NOW = new Date('2026-10-28T12:00:00Z')

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  progress = await import('./progress')
  evidence = await import('@/lib/learning/evidence')
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

async function world(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const concept = (name: string, orderIndex = 0) =>
    prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] } })
  return { user, project, topic, concept }
}

type W = Awaited<ReturnType<typeof world>>

let answerNumber = 0

/** Raw events (no memory rows): enough for the figures that only read the event log. Each is its own answer. */
async function events(w: W, conceptId: string, specs: { at: Date; score: number; assistance?: number; confidence?: number; source?: string }[]) {
  await prisma.evidenceEvent.createMany({
    data: specs.map((spec) => ({
      userId: w.user.id,
      projectId: w.project.id,
      topicId: w.topic.id,
      conceptId,
      itemKey: `quiz:set:${++answerNumber}`,
      source: spec.source ?? 'quiz',
      score: spec.score,
      assistance: spec.assistance ?? 0,
      confidence: spec.confidence ?? null,
      weight: 1,
      role: 'primary',
      gradedBy: 'rule',
      sessionKey: `s-${answerNumber}-${spec.at.getTime()}`,
      createdAt: spec.at,
    })),
  })
}

const times = (count: number, at: Date, score: number, extra: { assistance?: number; confidence?: number; source?: string } = {}) =>
  Array.from({ length: count }, (_, n) => ({ at: new Date(at.getTime() + n * 1000), score, ...extra }))

const get = (w: W) => progress.getProgress(w.user.id, w.project.id, { timeZone: ZONE, now: NOW })

/** One level-0 answer through the real writer, so the concept's memory row is built the way the app builds it. */
async function answer(
  w: W,
  conceptId: string,
  input: { at: Date; score: number; session: string; metadata?: Record<string, unknown>; confidence?: number; topicId?: string }
) {
  await evidence.recordEvidence(
    [
      {
        userId: w.user.id,
        projectId: w.project.id,
        topicId: input.topicId ?? w.topic.id,
        itemKey: `quiz:${input.session}:0`,
        conceptIds: [conceptId],
        source: 'quiz',
        score: input.score,
        assistance: 0,
        confidence: input.confidence,
        gradedBy: 'rule',
        sessionKey: `quiz:${input.session}`,
        metadata: input.metadata,
        at: input.at,
      },
    ],
    { timeZone: ZONE, userId: w.user.id }
  )
}

test('weekly accuracy is level-0 scores plus level-1 failures as 0', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('weekly')
  const c = await w.concept('Hashing')
  const lastWeek = new Date(NOW.getTime() - 7 * DAY)
  await events(w, c.id, [
    ...times(10, lastWeek, 0.5),
    // A first try that failed and then needed a hint, tutor or reveal is a failed unassisted try: it counts, as 0
    // (even when a row carries a higher score).
    ...times(4, lastWeek, 0.8, { assistance: 1 }),
    // Correct after help (level 2 and 3) is not the student's own try.
    ...times(4, lastWeek, 1, { assistance: 2 }),
    ...times(4, lastWeek, 1, { assistance: 3 }),
    // Credit inferred from a neighbouring concept is not an answer, and a warm-up is a pretest.
    ...times(5, lastWeek, 1, { source: 'implicit' }),
    ...times(5, lastWeek, 1, { source: 'warmup' }),
  ])
  const result = await get(w)
  assert.equal(result.weekly.length, 1)
  assert.equal(result.weekly[0].week, '2026-10-19')
  assert.equal(result.weekly[0].n, 14)
  assert.ok(Math.abs(result.weekly[0].accuracy - 5 / 14) < 1e-9)
})

test('weeks under 10 events hidden', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('hidden')
  const c = await w.concept('Hashing')
  await events(w, c.id, [
    ...times(9, new Date('2026-10-12T10:00:00Z'), 1), // week of 10-12: nine events, hidden
    ...times(10, new Date('2026-10-19T10:00:00Z'), 0.8), // exactly ten: shown
    ...times(12, new Date('2026-10-26T09:00:00Z'), 0.6), // this week
  ])
  const result = await get(w)
  assert.deepEqual(
    result.weekly.map((row) => [row.week, row.n]),
    [
      ['2026-10-19', 10],
      ['2026-10-26', 12],
    ]
  )
  assert.ok(Math.abs(result.weekly[0].accuracy - 0.8) < 1e-9)
  assert.ok(Math.abs(result.weekly[1].accuracy - 0.6) < 1e-9)

  const none = await world('none')
  await events(none, (await none.concept('Hashing')).id, times(9, new Date(NOW.getTime() - HOUR), 1))
  assert.deepEqual((await get(none)).weekly, [])
})

test('weeks start on Monday in the student zone', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('zone')
  const c = await w.concept('Hashing')
  // 2026-10-26 03:00 UTC is still Sunday 25 Oct evening in Los Angeles: last week there, this week in UTC.
  await events(w, c.id, times(10, new Date('2026-10-26T03:00:00Z'), 1))
  const la = await progress.getProgress(w.user.id, w.project.id, { timeZone: 'America/Los_Angeles', now: NOW })
  assert.deepEqual(la.weekly.map((row) => row.week), ['2026-10-19'])
  assert.deepEqual((await get(w)).weekly.map((row) => row.week), ['2026-10-26'])
})

test('assisted share counts every answer at level 1 or more', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('assisted')
  const c = await w.concept('Hashing')
  const monday = new Date('2026-10-26T09:00:00Z')
  await events(w, c.id, [
    ...times(5, monday, 1), // level 0
    ...times(2, monday, 0, { assistance: 1 }), // a hint, tutor turn or reveal after a miss is help (spec §3.3)
    ...times(2, monday, 0.5, { assistance: 2 }),
    ...times(1, monday, 0, { assistance: 3 }),
    ...times(3, monday, 1, { source: 'implicit' }), // not answers
    ...times(4, monday, 0, { assistance: 3, source: 'instruction' }), // instruction is not an answer (spec 18.5)
    ...times(4, monday, 0, { source: 'warmup' }), // a pretest before teaching: not counted either way
    // Last week's help is not this week's.
    ...times(6, new Date('2026-10-20T09:00:00Z'), 0, { assistance: 3 }),
  ])
  const shared = await get(w)
  assert.equal(shared.assistedShare, 5 / 10)
  assert.equal(shared.weekAnswers, 10)

  const quiet = await world('assisted-none')
  const none = await get(quiet)
  assert.equal(none.assistedShare, 0)
  assert.equal(none.weekAnswers, 0)
})

test('calibration reads level-0 events with a confidence', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('calibration')
  const c = await w.concept('Hashing')
  const when = new Date(NOW.getTime() - 3 * DAY)
  await events(w, c.id, [
    ...times(20, when, 1, { confidence: 0.95 }),
    ...times(9, when, 0.5, { confidence: 0.5 }),
    ...times(5, when, 1), // no confidence tap: not in calibration
    ...times(5, when, 1, { confidence: 0.95, assistance: 2 }), // helped: not in calibration
    ...times(5, when, 1, { confidence: 0.95, source: 'warmup' }), // a pretest: not in calibration
    // Older than the 90 days calibration looks back over.
    ...times(5, new Date(NOW.getTime() - 100 * DAY), 1, { confidence: 0.95 }),
  ])
  const result = await get(w)
  assert.equal(result.calibration.n, 29)
  assert.equal(result.calibration.ready, false)
  await events(w, c.id, times(1, when, 0, { confidence: 0.75 }))
  const ready = (await get(w)).calibration
  assert.equal(ready.n, 30)
  assert.equal(ready.ready, true)
  // The sums done in the database give the Brier score the event-by-event function gives.
  assert.ok(Math.abs(ready.brier - (20 * 0.05 ** 2 + 0.75 ** 2) / 30) < 1e-9)
  assert.deepEqual(
    ready.bins.map((bin) => [bin.label, bin.n]),
    [
      ['guess', 0],
      ['unsure', 9],
      ['fairly', 1],
      ['certain', 20],
    ]
  )
})

test('focus lists misconception then plateau then lowest R, at most three', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('focus')
  const mis = await w.concept('Collisions', 0)
  const stuck = await w.concept('Load factor', 1)
  const old = await w.concept('Hashing', 2)
  const recent = await w.concept('Open addressing', 3)
  const fresh = await w.concept('Chaining', 4)

  // A live misconception: the grader named it.
  await answer(w, mis.id, { at: new Date(NOW.getTime() - 2 * DAY), score: 0, session: 'mis', metadata: { missKind: 'misconception', misconception: 'Thinks collisions cannot happen' } })
  // Failing twice in a row, with no misconception named.
  await answer(w, stuck.id, { at: new Date(NOW.getTime() - 3 * DAY), score: 0, session: 'stuck1' })
  await answer(w, stuck.id, { at: new Date(NOW.getTime() - 2 * DAY), score: 0, session: 'stuck2' })
  // Learned, and the memory has faded most for the one answered longest ago.
  await answer(w, old.id, { at: new Date(NOW.getTime() - 40 * DAY), score: 1, session: 'old' })
  await answer(w, recent.id, { at: new Date(NOW.getTime() - 10 * DAY), score: 1, session: 'recent' })
  await answer(w, fresh.id, { at: new Date(NOW.getTime() - HOUR), score: 1, session: 'fresh' })

  const result = await get(w)
  assert.deepEqual(
    result.focus.map((f) => [f.name, f.reason]),
    [
      ['Collisions', 'misconception'],
      ['Load factor', 'plateau'],
      ['Hashing', 'fading'],
    ]
  )
  assert.equal(result.focus[0].conceptId, mis.id)

  // A second misconception and a second plateau take the places of the fading concepts, in order.
  const mis2 = await w.concept('Rehashing', 5)
  await answer(w, mis2.id, { at: new Date(NOW.getTime() - DAY), score: 0, session: 'mis2', metadata: { missKind: 'misconception', misconception: 'Thinks rehashing keeps the order' } })
  const full = await get(w)
  assert.equal(full.focus.length, 3)
  assert.deepEqual(full.focus.map((f) => f.reason), ['misconception', 'misconception', 'plateau'])
  // The more recent misconception comes first.
  assert.deepEqual(full.focus.slice(0, 2).map((f) => f.name), ['Rehashing', 'Collisions'])
})

test('focus skips concepts never answered, and a fixed misconception', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('focus-empty')
  const untouched = await w.concept('Untouched', 0)
  const fixed = await w.concept('Fixed', 1)
  assert.deepEqual((await get(w)).focus, [])
  await answer(w, fixed.id, { at: new Date(NOW.getTime() - 5 * DAY), score: 0, session: 'a', metadata: { missKind: 'misconception', misconception: 'x' } })
  await answer(w, fixed.id, { at: new Date(NOW.getTime() - 1 * DAY), score: 1, session: 'b' })
  const result = await get(w)
  assert.ok(!result.focus.some((f) => f.conceptId === untouched.id))
  assert.ok(!result.focus.some((f) => f.reason === 'misconception'))
  assert.ok(!result.focus.some((f) => f.reason === 'plateau'))
})

test('progress is the student\'s own and the course\'s own', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('own')
  const other = await world('other')
  const c = await w.concept('Hashing')
  await events(w, c.id, times(12, new Date(NOW.getTime() - HOUR), 1))
  const mine = await get(w)
  assert.equal(mine.weekly.length, 1)
  assert.deepEqual((await get(other)).weekly, [])
  const crossed = await progress.getProgress(other.user.id, w.project.id, { timeZone: ZONE, now: NOW })
  assert.deepEqual(crossed.weekly, [])
})

test('an answer to an item that tests several concepts, or a step surrendered and then finished, is one answer', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('answers')
  const [a, b, c] = [await w.concept('A', 0), await w.concept('B', 1), await w.concept('C', 2)]
  const when = new Date(NOW.getTime() - 2 * DAY)
  const row = (conceptId: string, itemKey: string, over: { assistance?: number; score?: number; confidence?: number | null }) => ({
    userId: w.user.id,
    projectId: w.project.id,
    topicId: w.topic.id,
    conceptId,
    itemKey,
    source: 'quiz',
    score: over.score ?? 1,
    assistance: over.assistance ?? 0,
    confidence: over.confidence ?? null,
    weight: 1,
    role: 'primary',
    gradedBy: 'rule',
    sessionKey: 'quiz:one',
    createdAt: when,
  })
  await prisma.evidenceEvent.createMany({
    data: [
      // Ten answers, each testing three concepts: thirty events.
      ...Array.from({ length: 10 }, (_, n) => [a, b, c].map((concept) => row(concept.id, `quiz:multi:${n}`, { score: 1, confidence: 0.95 }))).flat(),
      // One more answer: a worked example shown (level 3), then the step finished (level 3 again).
      row(a.id, 'practice:p:0:1', { assistance: 3, score: 0 }),
      row(a.id, 'practice:p:0:1', { assistance: 3, score: 0.6 }),
    ],
  })
  const result = await get(w)
  assert.equal(result.weekAnswers, 11)
  assert.equal(result.assistedShare, 1 / 11)
  assert.equal(result.weekly.length, 1)
  assert.equal(result.weekly[0].n, 10)
  assert.equal(result.calibration.n, 10)
})

test('focus names the topic and the mix-up, and one idea written up twice in a topic is one card', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('focus-named')
  const other = await prisma.topic.create({ data: { projectId: w.project.id, name: 'Sorting', orderIndex: 1, userConfirmed: true } })
  const make = (topicId: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: w.project.id, topicId, name: 'Mock idea 1', summary: 'x.', kind: 'concept', orderIndex, objectiveIndexes: [] } })
  const first = await make(w.topic.id, 0)
  const twin = await make(w.topic.id, 1)
  const elsewhere = await make(other.id, 0)
  const miss = (conceptId: string, topicId: string, session: string, misconception: string, daysAgo: number) =>
    answer(w, conceptId, { at: new Date(NOW.getTime() - daysAgo * DAY), score: 0, session, topicId, metadata: { missKind: 'misconception', misconception } })
  await miss(first.id, w.topic.id, 'a', 'Thinks a hash is reversible', 1)
  await miss(twin.id, w.topic.id, 'b', 'Thinks a hash is reversible', 2)
  await miss(elsewhere.id, other.id, 'c', 'Thinks sorting is always stable', 3)

  const { focus } = await get(w)
  // The twin (same topic, same name, same mix-up) is dropped; the same name in another topic is another idea, told apart by its topic and mix-up.
  assert.deepEqual(
    focus.map((f) => [f.conceptId, f.topicName, f.misconception]),
    [
      [first.id, 'Hash tables', 'Thinks a hash is reversible'],
      [elsewhere.id, 'Sorting', 'Thinks sorting is always stable'],
    ]
  )
})

test('instruction events are not counted as help used', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('instruction-help')
  const c = await w.concept('Hashing')
  const monday = new Date('2026-10-26T09:00:00Z')
  await events(w, c.id, [...times(6, monday, 1), ...times(5, monday, 0, { assistance: 3, source: 'instruction' })])
  const result = await get(w)
  // Showing the idea after a miss is not a hint: six answers, none helped.
  assert.equal(result.weekAnswers, 6)
  assert.equal(result.assistedShare, 0)
  // And it is not a first try either.
  assert.deepEqual(result.weekly, [{ week: '2026-10-26', n: 6, accuracy: 1 }].filter((row) => row.n >= progress.MIN_WEEK_EVENTS))
})

test('idk counts in first tries at 0', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('idk-first-tries')
  const c = await w.concept('Hashing')
  const monday = new Date('2026-10-26T09:00:00Z')
  await events(w, c.id, [
    ...times(6, monday, 1),
    ...times(2, monday, 0, { assistance: 1 }), // "I don't remember" on recall: a failed first try at level 1
    ...times(2, monday, 0), // "I don't know" in a quiz: level 0, score 0
    ...times(3, monday, 0, { source: 'warmup' }), // a warm-up "I don't know" is a pretest: left out
  ])
  const result = await get(w)
  assert.deepEqual(result.weekly, [{ week: '2026-10-26', n: 10, accuracy: 0.6 }])
})

test('the first week of answers is exposed, so the panel knows the early weeks', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('first-week')
  const c = await w.concept('Hashing')
  assert.equal((await get(w)).firstWeekStart, null)
  assert.equal((await get(w)).thisWeek, '2026-10-26')

  await events(w, c.id, [
    // Before the first answer: a warm-up, instruction and an inferred credit are not answers.
    ...times(1, new Date('2026-09-01T09:00:00Z'), 0, { source: 'warmup' }),
    ...times(1, new Date('2026-09-02T09:00:00Z'), 0, { assistance: 3, source: 'instruction' }),
    ...times(1, new Date('2026-09-03T09:00:00Z'), 1, { source: 'implicit' }),
    // The first answer is on a Wednesday: the week is the Monday before it.
    ...times(1, new Date('2026-10-14T09:00:00Z'), 1),
    ...times(3, new Date('2026-10-27T09:00:00Z'), 1),
  ])
  const result = await get(w)
  assert.equal(result.firstWeekStart, '2026-10-12')
  assert.equal(result.thisWeek, '2026-10-26')

  // Another course's answers are not this course's.
  const other = await world('first-week-other')
  assert.equal((await get(other)).firstWeekStart, null)
})

test('ideas that tie for the focus come in course order, whatever order their memories were written in', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('focus-tie')
  const ideas = [await w.concept('Probing', 0), await w.concept('Buckets', 1), await w.concept('Resizing', 2), await w.concept('Tombstones', 3)]
  // The same mix-up named at the same moment for each idea (one answer tagged with them all), written last idea first.
  const at = new Date(NOW.getTime() - DAY)
  for (const [n, idea] of [...ideas].reverse().entries()) {
    await answer(w, idea.id, { at, score: 0, session: `tie${n}`, metadata: { missKind: 'misconception', misconception: 'Thinks the table never fills' } })
  }
  const result = await get(w)
  assert.deepEqual(
    result.focus.map((f) => f.name),
    ['Probing', 'Buckets', 'Resizing']
  )
})
