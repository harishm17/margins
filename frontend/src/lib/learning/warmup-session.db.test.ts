/**
 * The warm-up against a real, migrated Postgres (DATABASE_URL). The AI service is a stub that grades
 * true/false by rule. Skipped when no database with the item_sessions table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let warmup: typeof import('./warmup-session')
let quizSets: typeof import('./quiz-sets')
let available = false
const realFetch = globalThis.fetch
let gradeCalls = 0

const ZONE = 'UTC'

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  warmup = await import('./warmup-session')
  quizSets = await import('./quiz-sets')
  available = await prisma.$queryRaw`SELECT 1 FROM item_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/status/ai')) return Response.json({ available: true })
    if (url.includes('/grade/quiz')) {
      gradeCalls += 1
      const graded = (body.questions as Record<string, unknown>[]).map((q, i) => {
        const given = body.answers[String(i)]
        const text = typeof given === 'string' ? given : given.answer
        const right = String(q.correct_answer) === text
        return { question_index: i, question_type: q.question_type, points_possible: 1, points_earned: right ? 1 : 0, is_correct: right, feedback: '', needs_review: false }
      })
      const earned = graded.reduce((sum, g) => sum + g.points_earned, 0)
      return Response.json({ graded_questions: graded, total_points: graded.length, earned_points: earned, overall_score: earned / graded.length, needs_review: false })
    }
    return realFetch(input, init)
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  if (available) await prisma.$disconnect()
})

/** A topic with three concepts and a warm-up bank of five true/false questions (the key is "true"), two easy, two medium, one hard. */
async function world(label: string, options: { bank?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const concepts = await Promise.all(
    ['Hash function', 'Collision', 'Load factor'].map((name, orderIndex) =>
      prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] } })
    )
  )
  const levels = ['easy', 'easy', 'medium', 'medium', 'hard']
  if (options.bank !== false) {
    await prisma.topicQuiz.create({
      data: {
        topicId: topic.id,
        kind: 'warmup',
        questions: levels.map((difficulty, n) => ({
          question_type: 'true_false',
          question_text: `Warm-up statement ${n} (${difficulty}) holds.`,
          correct_answer: true,
          explanation: 'It holds, and this must not reach the student.',
          points: 1,
          difficulty,
          mode: 'recall',
          concept_ids: [concepts[n % 3].id],
          sources: [{ material_id: null, filename: 'notes.pdf', page_start: 10 + n, page_end: 10 + n }],
        })),
      },
    })
  }
  return { user, project, topic, concepts }
}

const sure = { confidence: 0.75, confidenceLevel: 'fairly' as const }

test('starting serves a medium question without its key', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-start')
  const state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.status, 'asking')
  if (state.status !== 'asking') return
  assert.equal(state.total, 3)
  assert.equal(state.position, 1)
  assert.match(state.question.question_text, /\(medium\)/)
  assert.equal(JSON.stringify(state).includes('correct_answer'), false)
  assert.equal(JSON.stringify(state).includes('must not reach'), false)
  // The same session comes back when the page is opened again, and no new one is made.
  const before = await prisma.itemSession.count({ where: { userId: w.user.id, kind: 'warmup' } })
  assert.equal(before, 1)
  const again = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(again.status === 'asking' && again.sessionId, state.sessionId)
  assert.equal(await prisma.itemSession.count({ where: { userId: w.user.id, kind: 'warmup' } }), before)
})

test('warm-up starts medium, goes up on confident right and down on wrong or guess', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-bracket')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  const seen: string[] = []
  const take = async (answer: string, confidence = sure) => {
    assert.equal(state.status, 'asking')
    if (state.status !== 'asking') throw new Error('not asking')
    seen.push(/\((\w+)\)/.exec(state.question.question_text)?.[1] ?? '?')
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer, ...confidence }, timeZone: ZONE })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') state = result.state
  }
  await take('true') // medium, right and sure: up
  await take('false') // hard, wrong: down to medium
  await take('true', { confidence: 0.25, confidenceLevel: 'guess' as never }) // medium, a guess
  assert.deepEqual(seen, ['medium', 'hard', 'medium'])
  assert.equal(state.status, 'done')
})

test('warmup answers never appear in quiz history', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-history')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  for (let i = 0; i < 3; i++) {
    if (state.status !== 'asking') break
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'true', ...sure }, timeZone: ZONE })
    if (result.status === 'ok') state = result.state
  }
  assert.equal(state.status, 'done')
  assert.equal(await prisma.quizAttempt.count({ where: { userId: w.user.id } }), 0)
  // The bank is not a quiz set, whatever reads quiz sets.
  const sets = await prisma.topicQuiz.findMany({ where: { topicId: w.topic.id, kind: { in: ['standard', 'retry'] } } })
  assert.equal(sets.length, 0)
  assert.equal((await quizSets.loadAllQuizQuestionSets(w.topic.id)).size, 0)
})

test('the warm-up writes warmup evidence, sets warmupAt and the concepts inferred prior', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-evidence')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  // Nothing is set before the last answer; the first answer is already evidence.
  let answered = 0
  while (state.status === 'asking') {
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: answered === 1 ? 'false' : 'true', ...sure }, timeZone: ZONE })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    answered += 1
    state = result.state
    if (answered === 1) {
      assert.equal(await prisma.topicProgress.count({ where: { userId: w.user.id, topicId: w.topic.id, warmupAt: { not: null } } }), 0)
      assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'warmup' } }) > 0, true)
    }
  }
  assert.equal(state.status, 'done')
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.ok(events.length >= 3)
  assert.ok(events.every((e) => e.source === 'warmup' && e.assistance === 0))
  assert.ok(events.every((e) => e.sessionKey.startsWith('warmup:')))
  const progress = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.ok(progress.warmupAt)
  const memories = await prisma.conceptMemory.findMany({ where: { userId: w.user.id } })
  assert.ok(memories.length > 0)
  assert.ok(memories.every((m) => m.inferredPrior !== null && m.card === null))
  // The session is finished and holds the answers and their results.
  const row = await prisma.itemSession.findFirstOrThrow({ where: { userId: w.user.id, kind: 'warmup' } })
  assert.ok(row.completedAt)
})

test('the finished warm-up shows the key, the page and no explanation, and offers test-out only when all sure and right', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const sureAll = await world('wu-done-sure')
  const unsure = await world('wu-done-unsure')
  const run = async (w: Awaited<ReturnType<typeof world>>, confidence: Record<string, unknown>) => {
    let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
    while (state.status === 'asking') {
      const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'true', ...confidence }, timeZone: ZONE })
      if (result.status !== 'ok') throw new Error(result.status)
      state = result.state
    }
    return state
  }
  const done = await run(sureAll, sure)
  assert.equal(done.status, 'done')
  if (done.status !== 'done') return
  assert.equal(done.testOut, true)
  assert.equal(done.items.length, 3)
  assert.ok(done.items.every((item) => item.correct && item.correctAnswer === 'True' && item.sources[0]?.pageStart !== null))
  assert.equal(JSON.stringify(done).includes('must not reach'), false)
  // Loading the page again gives the same finished warm-up.
  const reloaded = await warmup.loadWarmupState(sureAll.user.id, sureAll.topic.id)
  assert.equal(reloaded.status, 'done')

  const other = await run(unsure, { confidence: 0.5, confidenceLevel: 'unsure' })
  assert.equal(other.status === 'done' && other.testOut, false)
})

test('answers come in order, once, and a stranger cannot answer', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-order')
  const stranger = await world('wu-stranger')
  const state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.status, 'asking')
  if (state.status !== 'asking') return
  const wrongIndex = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: (state.index + 1) % 5, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(wrongIndex.status, 'invalid')
  const empty = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: '  ' }, timeZone: ZONE })
  assert.equal(empty.status, 'invalid')
  const foreign = await warmup.answerWarmup({ userId: stranger.user.id, topicId: stranger.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'true' }, timeZone: ZONE })
  assert.equal(foreign.status, 'not_found')
  const first = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'true', ...sure }, timeZone: ZONE })
  assert.equal(first.status, 'ok')
  // The same answer sent again (a double click) changes nothing.
  const again = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'true', ...sure }, timeZone: ZONE })
  assert.equal(again.status, 'ok')
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'warmup' } }), (await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })).length)
})

test('an answer without a confidence rating is taken, and carries none', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-confidence')
  const state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.status, 'asking')
  if (state.status !== 'asking') return
  const base = { userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, timeZone: ZONE }
  const bare = await warmup.answerWarmup({ ...base, answer: { answer: 'true' } })
  assert.equal(bare.status, 'ok')
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'warmup' } })
  assert.ok(events.length > 0)
  assert.ok(events.every((event) => event.confidence === null))
})

test('a topic without a bank has no warm-up, and the state follows what was taken', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-none', { bank: false })
  assert.deepEqual(await warmup.loadWarmupState(w.user.id, w.topic.id), { status: 'none' })
  assert.equal((await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })).status, 'none')
  const w2 = await world('wu-ready')
  assert.deepEqual(await warmup.loadWarmupState(w2.user.id, w2.topic.id), { status: 'ready', total: 3 })
})

test('the latest finished warm-up gives the reader its focus chunks', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-focus')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(await warmup.latestWarmupResults(w.user.id, w.topic.id), null)
  while (state.status === 'asking') {
    // Every answer is wrong.
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'false', ...sure }, timeZone: ZONE })
    if (result.status !== 'ok') throw new Error(result.status)
    state = result.state
  }
  const results = await warmup.latestWarmupResults(w.user.id, w.topic.id)
  assert.equal(results?.length, 3)
  assert.ok(results?.every((r) => r.correct === false && r.conceptIds.length === 1))
})

/** "I don't know" on a warm-up question (spec 18.3): the button's answer. */
const IDK = { answer: '__idk__' }

test('warm-up idk scores 0 and steps down', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-idk')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  assert.equal(state.status, 'asking')
  if (state.status !== 'asking') return
  assert.match(state.question.question_text, /\(medium\)/)
  const calls = gradeCalls
  const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: IDK, timeZone: ZONE })
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  state = result.state
  // No grader was asked, and the bracket steps down to an easy question.
  assert.equal(gradeCalls, calls)
  assert.equal(state.status, 'asking')
  assert.match(state.status === 'asking' ? state.question.question_text : '', /\(easy\)/)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.ok(events.length > 0)
  assert.ok(events.every((e) => e.source === 'warmup' && e.assistance === 0 && e.score === 0 && e.gradedBy === 'rule'))
  assert.ok(events.every((e) => (e.metadata as Record<string, unknown>).idk === true && (e.metadata as Record<string, unknown>).missKind === 'cue_miss'))
  // A pretest: no memory card, and no instruction is owed for a warm-up miss.
  const memories = await prisma.conceptMemory.findMany({ where: { userId: w.user.id } })
  assert.ok(memories.every((m) => m.card === null))
  assert.ok(memories.every((m) => (m.derived as Record<string, unknown>).lastIdkAt == null))
})

test('idk carries no confidence', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('wu-idk-confidence')
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  // Every answer is an "I don't know", sent with no confidence (a normal answer without one is refused).
  while (state.status === 'asking') {
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: IDK, timeZone: ZONE })
    if (result.status !== 'ok') throw new Error(result.status)
    state = result.state
  }
  assert.equal(state.status, 'done')
  if (state.status !== 'done') return
  assert.ok(state.items.every((item) => item.idk === true && item.correct === false && item.confidence === undefined && item.answer === ''))
  assert.ok(state.items.every((item) => item.correctAnswer === 'True'))
  assert.equal(state.testOut, false)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.ok(events.length >= 3)
  assert.ok(events.every((e) => e.confidence === null))
  // The session holds an idk flag, not an answer, and the results still mark every concept as a miss.
  const row = await prisma.itemSession.findFirstOrThrow({ where: { userId: w.user.id, kind: 'warmup' } })
  const graded = Object.values((row.results as { graded: Record<string, { idk?: boolean; confidence?: number }> }).graded)
  assert.ok(graded.every((g) => g.idk === true && g.confidence === undefined))
  const results = await warmup.latestWarmupResults(w.user.id, w.topic.id)
  assert.ok(results?.every((r) => r.correct === false && r.confidence === undefined))
  assert.ok((await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })).warmupAt)
})
