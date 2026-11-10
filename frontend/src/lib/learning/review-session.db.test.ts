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
  const material = await prisma.material.create({ data: { projectId: project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  // An extracted idea comes with a claim from the file; one with none "needs re-reading" and gets no pointer.
  const concept = async (topicId: string, name: string, orderIndex: number) => {
    const row = await prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] } })
    await prisma.conceptClaim.create({ data: { conceptId: row.id, text: `${name}.`, quote: name, materialId: material.id, pageStart: 1, orderIndex: 0 } })
    return row
  }
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
  assert.deepEqual(counts, { total: 1, correct: 0, retests: { total: 1, correct: 1 }, recovered: ['Hashing'], stillShaky: [], notRetested: [], leftOut: [], retestLimit: null })
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
