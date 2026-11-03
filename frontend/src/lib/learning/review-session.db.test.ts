/**
 * Review sessions and concept drills against a real, migrated Postgres (DATABASE_URL). The AI service
 * is a stub: it grades true/false by rule and accepts the review-item job. Skipped when no database
 * with the item_sessions table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let session: typeof import('./review-session')
let evidence: typeof import('./evidence')
let quizSets: typeof import('./quiz-sets')
let available = false
const realFetch = globalThis.fetch
const sent: { url: string; body: unknown }[] = []
let aiAvailable = true
/** Runs once, at the next AI status read (a way to change a session while it is being advanced). */
let onStatusRead: (() => Promise<void>) | null = null

const DAY = 24 * 60 * 60 * 1000
const ZONE = 'UTC'

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  session = await import('./review-session')
  evidence = await import('./evidence')
  quizSets = await import('./quiz-sets')
  available = await prisma.$queryRaw`SELECT 1 FROM item_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
  // The AI service: status, rule grading of true/false, and the review-item job.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/status/ai') && onStatusRead) {
      const run = onStatusRead
      onStatusRead = null
      await run()
    }
    if (url.includes('/status/ai')) return Response.json(aiAvailable ? { available: true } : { available: false, reason: 'LLM_CREDIT_EXHAUSTED' })
    if (url.includes('/grade/quiz')) {
      const graded = (body.questions as Record<string, unknown>[]).map((q, i) => {
        const given = body.answers[String(i)]
        const text = typeof given === 'string' ? given : given.answer
        const right = String(q.correct_answer) === text
        return { question_index: i, question_type: q.question_type, points_possible: 1, points_earned: right ? 1 : 0, is_correct: right, feedback: '', needs_review: false }
      })
      const earned = graded.reduce((sum, g) => sum + g.points_earned, 0)
      return Response.json({ graded_questions: graded, total_points: graded.length, earned_points: earned, overall_score: earned / graded.length, needs_review: false })
    }
    if (url.includes('/jobs/generate-review-items')) {
      sent.push({ url, body })
      return Response.json({ status: 'success' })
    }
    return realFetch(input, init)
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  if (available) await prisma.$disconnect()
})

async function world(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topicA = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const topicB = await prisma.topic.create({ data: { projectId: project.id, name: 'Sorting', orderIndex: 1, userConfirmed: true } })
  const concept = (topicId: string, name: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] } })
  return { user, project, topicA, topicB, concept }
}

/** True/false items that are all true, one per concept per entry. */
const items = (specs: { conceptId: string; mode?: string; difficulty?: string; text?: string }[]) =>
  specs.map((spec, n) => ({
    question_type: 'true_false',
    question_text: spec.text ?? `Statement ${n} about ${spec.conceptId.slice(0, 6)} holds.`,
    correct_answer: true,
    explanation: 'It holds.',
    points: 1,
    difficulty: spec.difficulty ?? 'medium',
    mode: spec.mode ?? 'recall',
    concept_ids: [spec.conceptId],
  }))

/** Answers a concept at level 0 a month ago, so its card is overdue now. */
async function overdue(userId: string, projectId: string, topicId: string, conceptId: string, daysAgo = 30) {
  await evidence.recordEvidence(
    [
      {
        userId,
        projectId,
        topicId,
        itemKey: `quiz:old-${conceptId}:0`,
        conceptIds: [conceptId],
        source: 'quiz',
        score: 1,
        assistance: 0,
        gradedBy: 'rule',
        sessionKey: `quiz:old-${conceptId}`,
        at: new Date(Date.now() - daysAgo * DAY),
      },
    ],
    { timeZone: ZONE, userId }
  )
}

const start = (w: Awaited<ReturnType<typeof world>>, extra: Partial<Parameters<typeof session.startSession>[0]> = {}) =>
  session.startSession({ userId: w.user.id, projectId: w.project.id, kind: 'review', timeZone: ZONE, ...extra })

const reachable = async (id: string, userId: string) => {
  const view = await session.sessionView(userId, id, ZONE)
  assert.ok(view)
  return view
}

test('today\'s review mixes topics and writes review evidence', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('mix')
  const [a1, a2, b1] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicA.id, 'Collisions', 1), await w.concept(w.topicB.id, 'Quicksort', 0)]
  for (const [c, topic] of [[a1, w.topicA], [a2, w.topicA], [b1, w.topicB]] as const) await overdue(w.user.id, w.project.id, topic.id, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a1.id }, { conceptId: a2.id }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b1.id }]) } })

  const started = await start(w)
  assert.equal(started.status, 'created')
  const id = (started as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  assert.equal(view.status, 'active')
  assert.equal(view.items.length, 3)
  // No two in a row on one concept, and topics are mixed.
  assert.ok(new Set(view.items.map((i) => i.topicName)).size === 2)
  // The answer key never leaves the server before the answer.
  assert.ok(view.items.every((i) => !('correct_answer' in i.question)))
  assert.deepEqual(view.answered, {})

  const row = await prisma.itemSession.findUniqueOrThrow({ where: { id } })
  assert.equal(row.kind, 'review')
  assert.equal(await prisma.quizAttempt.count({ where: { userId: w.user.id } }), 0)

  const answered = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true', confidence: 0.75 }, timeZone: ZONE })
  assert.equal(answered.status, 'ok')
  view = (answered as { view: typeof view }).view
  assert.equal(view.answered['0'].correct, true)
  assert.equal(view.answered['0'].confidence, 0.75)
  assert.equal(view.next, 1)

  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, sessionKey: `review:${id}` } })
  assert.equal(events.length, 1)
  assert.equal(events[0].source, 'review')
  assert.equal(events[0].assistance, 0)
  assert.equal(events[0].confidence, 0.75)
  assert.equal((events[0].metadata as Record<string, unknown>).mode, 'recall')
  // The same answer sent again changes nothing.
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}` } }), 1)
})

test('session ends with retests of misses in a fresh form', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('retest')
  const c1 = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c1.id)
  const texts = ['Original question', 'Another question', 'Third question']
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items(texts.map((text) => ({ conceptId: c1.id, text, difficulty: 'easy' }))) } })

  const id = ((await start(w)) as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  assert.equal(view.items.length, 1)
  const first = view.items[0].question.question_text
  // A miss.
  const missed = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'false' }, timeZone: ZONE })
  view = (missed as { view: typeof view }).view
  assert.equal(view.answered['0'].correct, false)
  // The session did not end: a retest of the same concept in a different item follows.
  assert.equal(view.status, 'active')
  assert.equal(view.items.length, 2)
  assert.equal(view.items[1].phase, 'retest')
  assert.notEqual(view.items[1].question.question_text, first)
  assert.deepEqual(view.items[1].conceptNames, ['Hashing'])
  assert.equal(view.summary, null)

  const retested = await session.answerItem({ userId: w.user.id, sessionId: id, index: 1, answer: { answer: 'true' }, timeZone: ZONE })
  view = (retested as { view: typeof view }).view
  assert.equal(view.status, 'complete')
  assert.equal(view.next, null)
  const { helpAfterMiss: help, ...counts } = view.summary!
  assert.deepEqual(counts, { total: 1, correct: 0, retests: { total: 1, correct: 1 }, recovered: ['Hashing'], stillShaky: [], notRetested: [] })
  // What was missed still shows where to look, even when the retest went right.
  assert.deepEqual(help?.pointers.map((pointer) => pointer.conceptName), ['Hashing'])
  const row = await prisma.itemSession.findUniqueOrThrow({ where: { id } })
  assert.ok(row.completedAt)
  // Both answers are level-0 evidence; the retest is its own rating, so the miss is not averaged with it.
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}`, assistance: 0 } }), 1)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}:retest`, assistance: 0 } }), 1)
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: c1.id } } })
  assert.equal(memory.nUnassisted, 3)
  assert.equal(memory.consecutiveFails, 0)
  // The day's FSRS review is the miss (Again, a lapse), not the mean of the miss and the retest (Hard).
  assert.equal((memory.card as { lapses?: number } | null)?.lapses, 1)
})

test('answers must come in order and a finished session takes no more', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('order')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await overdue(w.user.id, w.project.id, w.topicB.id, b.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  const skipped = await session.answerItem({ userId: w.user.id, sessionId: id, index: 1, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(skipped.status, 'invalid')
  const stranger = await session.answerItem({ userId: 'someone-else', sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(stranger.status, 'not_found')
  assert.equal(await session.sessionView('someone-else', id, ZONE), null)
})

test('concepts with no fresh item are written by one job per topic and fill the session in when it finishes', async (t) => {
  if (!available) return t.skip('no migrated test database')
  sent.length = 0
  const w = await world('job')
  const [a1, a2] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicA.id, 'Collisions', 1)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a1.id)
  await overdue(w.user.id, w.project.id, w.topicA.id, a2.id)

  const started = await start(w)
  assert.equal(started.status, 'created')
  const id = (started as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  assert.equal(view.status, 'preparing')
  assert.equal(view.items.length, 0)

  const jobs = await prisma.processingJob.findMany({ where: { userId: w.user.id, jobType: 'generate_review_items' } })
  assert.equal(jobs.length, 1)
  const input = jobs[0].inputData as { topicId: string; requests: { conceptIds: string[]; mode: string; difficulty: string }[] }
  assert.equal(input.topicId, w.topicA.id)
  // Each concept once, even though the opener and the body both lacked an item for it.
  assert.deepEqual(input.requests.flatMap((r) => r.conceptIds).sort(), [a1.id, a2.id].sort())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sent.length, 1)

  // The job runs: it appends to the review bank and completes.
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, kind: 'review_bank', questions: items([{ conceptId: a1.id, difficulty: 'easy' }, { conceptId: a2.id, difficulty: 'easy' }]) } })
  await prisma.processingJob.update({ where: { id: jobs[0].id }, data: { status: 'completed', completedAt: new Date() } })
  view = await reachable(id, w.user.id)
  assert.equal(view.status, 'active')
  assert.equal(view.items.length, 2)
  assert.equal(view.items[0].phase, 'opening')
})

test('review items never appear as a quiz set', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('lobby')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, kind: 'review_bank', questions: items([{ conceptId: c.id }]) } })
  assert.equal((await quizSets.loadAllQuizQuestionSets(w.topicA.id)).size, 0)
})

test('an unavailable AI starts a session on what exists and refuses one that has nothing', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('noai')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await overdue(w.user.id, w.project.id, w.topicB.id, b.id)
  aiAvailable = false
  try {
    const { clearAiStatusCache } = await import('@/server/ai-status')
    clearAiStatusCache()
    assert.deepEqual(await start(w), { status: 'blocked', code: 'LLM_CREDIT_EXHAUSTED' })
    await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id }]) } })
    const started = await start(w)
    assert.equal(started.status, 'created')
    const view = await reachable((started as { sessionId: string }).sessionId, w.user.id)
    assert.equal(view.status, 'active')
    assert.equal(view.items.length, 1)
    assert.equal(await prisma.processingJob.count({ where: { userId: w.user.id, jobType: 'generate_review_items' } }), 0)
  } finally {
    aiAvailable = true
    const { clearAiStatusCache } = await import('@/server/ai-status')
    clearAiStatusCache()
  }
})

test('nothing due starts nothing', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('none')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c.id, 0)
  assert.deepEqual(await start(w), { status: 'empty', legacyReview: false })
  assert.equal(await prisma.itemSession.count({ where: { userId: w.user.id } }), 0)
})

test('a step surrendered on an earlier day comes back the next day in a fresh item, once', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('surrender')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: c.id, text: 'A fresh question' }]) } })
  const base = { userId: w.user.id, projectId: w.project.id, topicId: w.topicA.id, conceptIds: [c.id], source: 'practice' as const, gradedBy: 'rule' as const, sessionKey: 'practice:content:2026-11-08' }
  const key = 'practice:content:0:1'
  // The surrender, then the finished step (its own event, flagged too), both on an earlier day.
  await evidence.recordEvidence(
    [
      { ...base, itemKey: key, score: 0, assistance: 3, at: new Date(Date.now() - 2 * DAY), metadata: { maxRung: 4, surrendered: true, contentId: 'content', problemIndex: 0, step: 1 } },
      { ...base, itemKey: key, score: 1, assistance: 3, at: new Date(Date.now() - 2 * DAY + 60_000), metadata: { maxRung: 4, surrendered: true } },
    ],
    { timeZone: ZONE, userId: w.user.id }
  )
  const started = await start(w)
  assert.equal(started.status, 'created')
  const view = await reachable((started as { sessionId: string }).sessionId, w.user.id)
  assert.equal(view.items.length, 1)
  assert.equal(view.items[0].question.question_text, 'A fresh question')
  await session.answerItem({ userId: w.user.id, sessionId: (started as { sessionId: string }).sessionId, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  // Answered unaided: it is no longer owed.
  assert.deepEqual(await start(w), { status: 'empty', legacyReview: false })
})

test('concept drill includes weak prerequisite', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('drill')
  const prerequisite = await w.concept(w.topicA.id, 'Hashing', 0)
  const target = await w.concept(w.topicB.id, 'Hash joins', 0)
  await prisma.conceptEdge.create({
    data: { projectId: w.project.id, sourceId: prerequisite.id, targetId: target.id, type: 'prerequisite', weight: 1, confidence: 0.9, origin: 'llm', status: 'confirmed' },
  })
  await overdue(w.user.id, w.project.id, w.topicA.id, prerequisite.id, 30)
  await overdue(w.user.id, w.project.id, w.topicB.id, target.id, 30)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: prerequisite.id }]) } })
  await prisma.topicQuiz.create({
    data: {
      topicId: w.topicB.id,
      questions: items([
        { conceptId: target.id, text: 'T1' },
        { conceptId: target.id, text: 'T2' },
        { conceptId: target.id, text: 'T3', mode: 'composition' },
        { conceptId: target.id, text: 'T4', mode: 'composition' },
      ]),
    },
  })

  const started = await start(w, { kind: 'drill', conceptId: target.id })
  assert.equal(started.status, 'created')
  const view = await reachable((started as { sessionId: string }).sessionId, w.user.id)
  assert.equal(view.items.length, 5)
  assert.equal(view.items[0].phase, 'prerequisite')
  assert.deepEqual(view.items[0].conceptNames, ['Hashing'])
  assert.equal(view.items.filter((i) => i.phase === 'drill').length, 4)
  assert.equal(view.title, 'Hash joins')

  // A drill answer is drill evidence and no retests follow.
  const id = (started as { sessionId: string }).sessionId
  for (let i = 0; i < 5; i++) await session.answerItem({ userId: w.user.id, sessionId: id, index: i, answer: { answer: 'true' }, timeZone: ZONE })
  const done = await reachable(id, w.user.id)
  assert.equal(done.status, 'complete')
  assert.equal(done.items.length, 5)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `drill:${id}`, source: 'drill' } }), 5)
})

test('a drill on a concept that is not in the course is not found', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('missing')
  assert.deepEqual(await start(w, { kind: 'drill', conceptId: 'nope' }), { status: 'not_found' })
})

test('a session filtered to a topic serves that topic\'s due concepts and at most two others', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('scope')
  const own = await w.concept(w.topicA.id, 'Hashing', 0)
  const others = [await w.concept(w.topicB.id, 'Quicksort', 0), await w.concept(w.topicB.id, 'Mergesort', 1), await w.concept(w.topicB.id, 'Heapsort', 2)]
  for (const c of [own, ...others]) await overdue(w.user.id, w.project.id, c.topicId, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: own.id }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items(others.map((c) => ({ conceptId: c.id }))) } })

  const started = await start(w, { topicId: w.topicA.id })
  const view = await reachable((started as { sessionId: string }).sessionId, w.user.id)
  assert.equal(view.title, 'Hash tables')
  assert.equal(view.items.length, 3)
  assert.equal(view.items.filter((i) => i.topicName === 'Hash tables').length, 1)
})

test('a miss with no fresh item asks for one, and the session ends saying so when none is written', async (t) => {
  if (!available) return t.skip('no migrated test database')
  sent.length = 0
  const w = await world('noretest')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: c.id, difficulty: 'easy' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId

  const missed = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'false' }, timeZone: ZONE })
  let view = (missed as { view: Awaited<ReturnType<typeof reachable>> }).view
  // Nothing else on the concept: the retest is asked for, and the session waits for it.
  assert.equal(view.status, 'preparing')
  const jobs = await prisma.processingJob.findMany({ where: { userId: w.user.id, jobType: 'generate_review_items' } })
  assert.equal(jobs.length, 1)
  assert.deepEqual((jobs[0].inputData as { requests: unknown[] }).requests, [{ conceptIds: [c.id], mode: 'recall', difficulty: 'easy' }])

  // The job fails: the session is not held up, and the summary says the miss was not retested.
  await prisma.processingJob.update({ where: { id: jobs[0].id }, data: { status: 'failed', completedAt: new Date() } })
  view = await reachable(id, w.user.id)
  assert.equal(view.status, 'complete')
  assert.deepEqual(view.summary?.notRetested, ['Hashing'])
  assert.equal(view.items.length, 1)
})

test('a retest the job wrote is served when it finishes', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('lateretest')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: c.id, difficulty: 'easy' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'false' }, timeZone: ZONE })
  const [job] = await prisma.processingJob.findMany({ where: { userId: w.user.id, jobType: 'generate_review_items' } })

  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, kind: 'review_bank', questions: items([{ conceptId: c.id, difficulty: 'easy', text: 'Written for the retest' }]) } })
  await prisma.processingJob.update({ where: { id: job.id }, data: { status: 'completed', completedAt: new Date() } })
  const view = await reachable(id, w.user.id)
  assert.equal(view.status, 'active')
  assert.equal(view.items.length, 2)
  assert.equal(view.items[1].phase, 'retest')
  assert.equal(view.items[1].question.question_text, 'Written for the retest')
})

const shortAnswer = (conceptId: string, text: string) => ({
  question_type: 'short_answer',
  question_text: text,
  sample_answer: 'An answer.',
  key_points: ['A point'],
  explanation: 'Why.',
  points: 2,
  difficulty: 'easy',
  mode: 'recall',
  concept_ids: [conceptId],
})

test('with the AI blocked only items graded by rule are served', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('blocked')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await overdue(w.user.id, w.project.id, w.topicB.id, b.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: [shortAnswer(a.id, 'Explain hashing.'), ...items([{ conceptId: a.id, difficulty: 'easy', text: 'Hashing is a mapping.' }])] } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: [shortAnswer(b.id, 'Explain quicksort.')] } })
  const { clearAiStatusCache } = await import('@/server/ai-status')
  aiAvailable = false
  try {
    clearAiStatusCache()
    // Quicksort has only a short answer: nothing it could be graded by, so the session is just hashing's true/false item.
    const started = await start(w)
    assert.equal(started.status, 'created')
    const view = await reachable((started as { sessionId: string }).sessionId, w.user.id)
    assert.deepEqual(view.items.map((i) => i.question.question_text), ['Hashing is a mapping.'])
    // A drill on the concept with the short answer and nothing else is refused, not served.
    assert.equal((await start(w, { kind: 'drill', conceptId: b.id })).status, 'blocked')
  } finally {
    aiAvailable = true
    clearAiStatusCache()
  }
  // With the AI back, the short answer is served too.
  const again = await start(w)
  const full = await reachable((again as { sessionId: string }).sessionId, w.user.id)
  assert.ok(full.items.some((i) => i.question.question_type === 'short_answer'))
})

test('skip for now moves the next question to the end without evidence', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('skip')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await overdue(w.user.id, w.project.id, w.topicB.id, b.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id, difficulty: 'easy', text: 'First question.' }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id, difficulty: 'easy', text: 'Second question.' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  const before = await reachable(id, w.user.id)
  const firstText = before.items[0].question.question_text

  const out = await session.skipItem({ userId: w.user.id, sessionId: id, index: 1, timeZone: ZONE })
  assert.equal(out.status, 'invalid') // only the next one can be skipped
  const skipped = await session.skipItem({ userId: w.user.id, sessionId: id, index: 0, timeZone: ZONE })
  assert.equal(skipped.status, 'ok')
  const view = (skipped as { view: typeof before }).view
  assert.equal(view.items[1].question.question_text, firstText)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}` } }), 0)
  // The last question left cannot be skipped: it has to be answered.
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal((await session.skipItem({ userId: w.user.id, sessionId: id, index: 1, timeZone: ZONE })).status, 'invalid')
  const done = await session.answerItem({ userId: w.user.id, sessionId: id, index: 1, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal((done as { view: typeof before }).view.status, 'complete')
})

test('a topic with no concepts and a quiz review due is sent to that review, not told nothing is due', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('legacy')
  await prisma.reviewSchedule.create({ data: { userId: w.user.id, projectId: w.project.id, topicId: w.topicA.id, mastery: 0.5, dueAt: new Date(Date.now() - DAY), intervalDays: 3 } })
  assert.deepEqual(await start(w, { topicId: w.topicA.id }), { status: 'empty', legacyReview: true })
  assert.deepEqual(await start(w, { topicId: w.topicB.id }), { status: 'empty', legacyReview: false })
  assert.deepEqual(await start(w, { topicId: 'not-a-topic' }), { status: 'not_found' })
})

test('every AI-graded item due and the AI blocked is a blocked start, not "nothing is due"', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('blockedall')
  const a = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: [shortAnswer(a.id, 'Explain hashing.')] } })
  const { clearAiStatusCache } = await import('@/server/ai-status')
  aiAvailable = false
  try {
    clearAiStatusCache()
    assert.deepEqual(await start(w), { status: 'blocked', code: 'LLM_CREDIT_EXHAUSTED' })
  } finally {
    aiAvailable = true
    clearAiStatusCache()
  }
  assert.equal((await start(w)).status, 'created')
})

test('a job made by an attempt that lost the race is still sent', async (t) => {
  if (!available) return t.skip('no migrated test database')
  sent.length = 0
  const w = await world('race')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: c.id, difficulty: 'easy' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  const { clearAiStatusCache } = await import('@/server/ai-status')
  clearAiStatusCache()
  // While the answer's advance reads the AI status, another reader changes the session row: the first attempt
  // has made the retest job by then and its write is refused; the second finds the job and must not lose it.
  onStatusRead = async () => {
    const row = await prisma.itemSession.findUniqueOrThrow({ where: { id } })
    await prisma.itemSession.update({ where: { id }, data: { results: { ...(row.results as object), touched: 1 } } })
  }
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'false' }, timeZone: ZONE })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await prisma.processingJob.count({ where: { userId: w.user.id, jobType: 'generate_review_items' } }), 1)
  assert.equal(sent.length, 1)
  // The second attempt wrote the row (the other reader's extra field is gone), so a retry did happen.
  const stored = (await prisma.itemSession.findUniqueOrThrow({ where: { id } })).results as Record<string, unknown>
  assert.equal(stored.touched, undefined)
  assert.equal(stored.retestsBuilt, true)
  assert.equal((await reachable(id, w.user.id)).status, 'preparing')
})

test('an answer and its evidence are stored together: a failed session update leaves no evidence, and the retry stores both once', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('atomic')
  const c1 = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c1.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: c1.id, difficulty: 'easy' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId

  const name = `rs_fail_${id.replace(/-/g, '')}`
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'session update refused'; END; $$ LANGUAGE plpgsql`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON item_sessions FOR EACH ROW WHEN (NEW.id = '${id}') EXECUTE FUNCTION ${name}()`)
  try {
    await assert.rejects(session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE }))
    assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}` } }), 0)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON item_sessions`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
  }
  const again = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(again.status, 'ok')
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}` } }), 1)
})

// ---- v3.1 workstream S: resume, abandon, I don't know, the end screen that teaches, short sessions ----

test('review resumes today\'s session', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('resume')
  const [a, b, c] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0), await w.concept(w.topicB.id, 'Mergesort', 1)]
  for (const concept of [a, b, c]) await overdue(w.user.id, w.project.id, concept.topicId, concept.id)
  // Easy items, so no question has to be written first and the session can finish.
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id, difficulty: 'easy' }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id, difficulty: 'easy' }, { conceptId: c.id, difficulty: 'easy' }]) } })

  assert.equal(await session.activeSession(w.user.id, w.project.id, ZONE), null)
  const started = await start(w)
  const id = (started as { sessionId: string }).sessionId
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  await session.answerItem({ userId: w.user.id, sessionId: id, index: 1, answer: { answer: 'true' }, timeZone: ZONE })

  // The Review page offers to resume it, with the count.
  assert.deepEqual(await session.activeSession(w.user.id, w.project.id, ZONE), { sessionId: id, answered: 2, total: 3, kind: 'review', short: false, topicId: null })
  // Finished, it is no longer offered.
  const finished = await session.answerItem({ userId: w.user.id, sessionId: id, index: 2, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal((finished as { view: { status: string } }).view.status, 'complete')
  assert.equal(await session.activeSession(w.user.id, w.project.id, ZONE), null)
})

test('yesterday\'s session closes as abandoned', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('abandon')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  await overdue(w.user.id, w.project.id, w.topicA.id, a.id)
  await overdue(w.user.id, w.project.id, w.topicB.id, b.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id, difficulty: 'easy' }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id, difficulty: 'easy' }]) } })
  const oldId = ((await start(w)) as { sessionId: string }).sessionId
  // One of the two is answered; the other is left.
  await session.answerItem({ userId: w.user.id, sessionId: oldId, index: 0, answer: { answer: 'true' }, timeZone: ZONE })
  // It is the next day: the session was left unfinished two days ago.
  await prisma.itemSession.update({ where: { id: oldId }, data: { createdAt: new Date(Date.now() - 2 * DAY) } })
  assert.equal(await session.activeSession(w.user.id, w.project.id, ZONE), null)

  const fresh = await start(w)
  assert.equal(fresh.status, 'created')
  assert.notEqual((fresh as { sessionId: string }).sessionId, oldId)
  const old = await prisma.itemSession.findUniqueOrThrow({ where: { id: oldId } })
  assert.ok(old.completedAt)
  assert.equal((old.results as { abandoned?: boolean }).abandoned, true)
  // What was answered keeps its evidence.
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${oldId}` } }), 1)
})

test('idk is a miss and gets a closing retest', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('idk')
  const c = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, c.id)
  await prisma.topicQuiz.create({
    data: { topicId: w.topicA.id, questions: items([{ conceptId: c.id, text: 'Original question', difficulty: 'easy' }, { conceptId: c.id, text: 'The fresh form', difficulty: 'easy' }]) },
  })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  const first = (await reachable(id, w.user.id)).items[0].question.question_text
  const result = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: '', idk: true, confidence: 0.95 }, timeZone: ZONE })
  assert.equal(result.status, 'ok')
  const view = (result as { view: Awaited<ReturnType<typeof reachable>> }).view
  assert.equal(view.answered['0'].correct, false)
  assert.equal(view.answered['0'].idk, true)
  // The answer is shown, as for any miss.
  assert.equal(view.answered['0'].review.correctAnswer, 'True')
  // A closing retest of the same concept in a different item follows.
  assert.equal(view.items.length, 2)
  assert.equal(view.items[1].phase, 'retest')
  assert.notEqual(view.items[1].question.question_text, first)
  assert.equal(view.retestsToCome, 0)

  const [event] = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, sessionKey: `review:${id}` } })
  assert.equal(event.source, 'review')
  assert.equal(event.score, 0)
  assert.equal(event.assistance, 0)
  assert.equal(event.confidence, null)
  assert.equal((event.metadata as Record<string, unknown>).idk, true)
  assert.equal((event.metadata as Record<string, unknown>).missKind, 'cue_miss')
  assert.equal((event.metadata as Record<string, unknown>).misconception, undefined)
  // Nothing was sent to the grader for it.
  // The same answer sent again is the stored one.
  const again = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: '', idk: true }, timeZone: ZONE })
  assert.equal(again.status, 'ok')
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, sessionKey: `review:${id}` } }), 1)
})

test('the counter says how many retests are to come', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('counter')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  for (const c of [a, b]) await overdue(w.user.id, w.project.id, c.topicId, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id, difficulty: 'easy' }, { conceptId: a.id, text: 'A fresh form', difficulty: 'easy' }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id, difficulty: 'easy' }, { conceptId: b.id, text: 'B fresh form', difficulty: 'easy' }]) } })
  const id = ((await start(w)) as { sessionId: string }).sessionId
  assert.equal((await reachable(id, w.user.id)).retestsToCome, 0)
  const missed = await session.answerItem({ userId: w.user.id, sessionId: id, index: 0, answer: { answer: 'false' }, timeZone: ZONE })
  assert.equal((missed as { view: { retestsToCome: number } }).view.retestsToCome, 1)
  // Once every question is answered the retest is served and is a question of its own, no longer "to come".
  const right = await session.answerItem({ userId: w.user.id, sessionId: id, index: 1, answer: { answer: 'true' }, timeZone: ZONE })
  const after = (right as { view: { retestsToCome: number; items: { phase: string }[] } }).view
  assert.equal(after.retestsToCome, 0)
  assert.equal(after.items.filter((item) => item.phase === 'retest').length, 1)
})

test('drill summary has pointers and no not-retested line', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('drillend')
  const target = await w.concept(w.topicA.id, 'Hashing', 0)
  await overdue(w.user.id, w.project.id, w.topicA.id, target.id)
  const material = await prisma.material.create({
    data: { projectId: w.project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'e2e/notes.pdf', sizeBytes: BigInt(10), validationStatus: 'valid' },
  })
  await prisma.conceptClaim.create({
    data: { conceptId: target.id, text: 'Hashing maps keys to slots.', quote: 'Hashing maps keys to slots.', materialId: material.id, chunkId: 'chunk-1', pageStart: 12, pageEnd: 12, orderIndex: 0 },
  })
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([1, 2, 3, 4].map((n) => ({ conceptId: target.id, text: `Drill question ${n}`, mode: n > 2 ? 'composition' : 'recall' }))) } })

  const started = await start(w, { kind: 'drill', conceptId: target.id })
  const id = (started as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  const total = view.items.length
  assert.ok(total >= 3)
  // 0 of N.
  for (let i = 0; i < total; i++) {
    const result = await session.answerItem({ userId: w.user.id, sessionId: id, index: i, answer: { answer: 'false' }, timeZone: ZONE })
    view = (result as { view: typeof view }).view
  }
  assert.equal(view.status, 'complete')
  assert.equal(view.summary?.correct, 0)
  // A drill never has a closing retest, so it never says one was missing.
  assert.deepEqual(view.summary?.notRetested, [])
  // It shows what to read: the page of the concept's first claim, as a link to the reader.
  const pointers = view.summary?.helpAfterMiss?.pointers ?? []
  assert.equal(pointers.length, 1)
  assert.equal(pointers[0].conceptName, 'Hashing')
  assert.equal(pointers[0].page, 12)
  assert.match(pointers[0].href, /view=read&focus=.*#chunk-chunk-1/)
  // And each missed answer carries its pointer.
  assert.equal(view.answered['0'].pointers?.[0].page, 12)
})

test('limit and includeNotDue build a four-item session', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('short')
  const concepts = [] as Awaited<ReturnType<typeof w.concept>>[]
  for (let n = 0; n < 5; n++) concepts.push(await w.concept(w.topicA.id, `Concept ${n}`, n))
  // None is due: they were answered well a minute ago.
  for (const c of concepts) await overdue(w.user.id, w.project.id, w.topicA.id, c.id, 0)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items(concepts.map((c, n) => ({ conceptId: c.id, text: `Mini question ${n}`, difficulty: 'easy' }))) } })
  assert.deepEqual(await start(w), { status: 'empty', legacyReview: false })

  const started = await start(w, { limit: 4, includeNotDue: true, retestCap: 0, topicIds: [w.topicA.id], short: true })
  assert.equal(started.status, 'created')
  const id = (started as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  assert.equal(view.items.length, 4)
  assert.equal(view.short, true)
  // A miss gets no closing retest when the cap is zero: the session ends after four answers.
  for (let i = 0; i < 4; i++) {
    const result = await session.answerItem({ userId: w.user.id, sessionId: id, index: i, answer: { answer: i === 0 ? 'false' : 'true' }, timeZone: ZONE })
    view = (result as { view: typeof view }).view
  }
  assert.equal(view.status, 'complete')
  assert.equal(view.items.length, 4)
  assert.equal(view.retestsToCome, 0)
  const row = await prisma.itemSession.findUniqueOrThrow({ where: { id } })
  assert.equal((row.results as { short?: boolean }).short, true)
  assert.equal(await prisma.quizAttempt.count({ where: { userId: w.user.id } }), 0)
})

test('a retest cap of one serves one closing retest of two misses', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world('cap')
  const [a, b] = [await w.concept(w.topicA.id, 'Hashing', 0), await w.concept(w.topicB.id, 'Quicksort', 0)]
  for (const c of [a, b]) await overdue(w.user.id, w.project.id, c.topicId, c.id)
  await prisma.topicQuiz.create({ data: { topicId: w.topicA.id, questions: items([{ conceptId: a.id, text: 'A1', difficulty: 'easy' }, { conceptId: a.id, text: 'A2', difficulty: 'easy' }]) } })
  await prisma.topicQuiz.create({ data: { topicId: w.topicB.id, questions: items([{ conceptId: b.id, text: 'B1', difficulty: 'easy' }, { conceptId: b.id, text: 'B2', difficulty: 'easy' }]) } })
  const id = ((await start(w, { retestCap: 1 })) as { sessionId: string }).sessionId
  let view = await reachable(id, w.user.id)
  assert.equal(view.items.length, 2)
  assert.equal(view.retestsToCome, 0)
  for (let i = 0; i < 2; i++) view = ((await session.answerItem({ userId: w.user.id, sessionId: id, index: i, answer: { answer: 'false' }, timeZone: ZONE })) as { view: typeof view }).view
  assert.equal(view.items.filter((item) => item.phase === 'retest').length, 1)
})
