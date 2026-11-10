/**
 * Ask's tutoring against a real, migrated Postgres (DATABASE_URL): the thread's tutor state after a turn, the level-3
 * evidence of a reply that taught, the check card's grade, and the open exam's questions. Skipped when no database with
 * the chat_messages.tutor column answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AskRoute } from './tutor-message'

let prisma: typeof import('@/lib/db/prisma').prisma
let turn: typeof import('./ask-turn')
let check: typeof import('./ask-check')
let guard: typeof import('./exam-guard-server')
let tutorMessage: typeof import('./tutor-message')
let store: typeof import('@/lib/tutor/store')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  turn = await import('./ask-turn')
  check = await import('./ask-check')
  guard = await import('./exam-guard-server')
  tutorMessage = await import('./tutor-message')
  store = await import('@/lib/tutor/store')
  available = await prisma.$queryRaw`SELECT tutor FROM chat_messages LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

const dbTest = (name: string, run: () => Promise<void>) =>
  test(name, async (t) => {
    if (!available) return t.skip('no migrated test database')
    await run()
  })

async function world() {
  const user = await prisma.user.create({ data: { email: `ask-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hashing', orderIndex: 0, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'Hash tables', summary: 'Keys map to buckets.', kind: 'concept', orderIndex: 0 },
  })
  const thread = await prisma.chatThread.create({ data: { userId: user.id, projectId: project.id, title: 'T' } })
  return { user, project, topic, concept, thread }
}
type World = Awaited<ReturnType<typeof world>>

const route = (w: World, overrides: Partial<AskRoute> = {}): AskRoute => ({
  intent: 'understand',
  hasAttempt: true,
  wantsAnswer: false,
  concepts: ['Hash tables'],
  conceptIds: [w.concept.id],
  broad: false,
  degraded: false,
  ...overrides,
})

const card = { question: 'What is a bucket?', answer: 'A slot that holds keys', explanation: 'Keys map to slots.', conceptName: 'Hash tables' }

async function reply(w: World, stored: ReturnType<typeof tutorMessage.toStoredTutor> | null) {
  return prisma.chatMessage.create({
    data: { threadId: w.thread.id, role: 'assistant', content: 'The gap.', ...(stored ? { tutor: stored as never } : {}) },
    select: { id: true },
  })
}

async function finish(w: World, kind: 'ask' | 'show_worked', question: string, r: AskRoute | null, stopReason = 'end_turn', prior: readonly string[] = []) {
  const before = await turn.loadAskState(w.user.id, w.thread.id)
  const planned = turn.planAskTurn(before, question, kind, prior, await turn.loadUnderstand(w.user.id, w.thread.id))
  assert.ok(planned.ok)
  const message = await reply(w, null)
  return turn.finishAskTurn({
    userId: w.user.id,
    projectId: w.project.id,
    threadId: w.thread.id,
    messageId: message.id,
    plan: planned.plan,
    route: r,
    stopReason,
    timeZone: 'UTC',
  })
}

const events = (w: World) => prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })

dbTest('an explanation after an attempt records level 3 on the routed concept, with no score', async () => {
  const w = await world()
  await finish(w, 'ask', 'I think a hash table sorts its keys', route(w))
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].conceptId, w.concept.id)
  assert.equal(rows[0].source, 'ask_check')
  assert.equal(rows[0].assistance, 3)
  assert.equal(rows[0].score, 0)
  assert.match(rows[0].itemKey, new RegExp(`^ask:${w.thread.id}:.+:explained$`))
  // An explanation is not a step on the hint ladder.
  assert.equal((await store.getTutorState(w.user.id, 'ask', w.thread.id)).attempts, 0)
})

dbTest('a question back, the places to start, a lookup and a leak fallback record nothing', async () => {
  const w = await world()
  await finish(w, 'ask', 'Explain hash tables', route(w, { hasAttempt: false }))
  await finish(w, 'ask', 'Explain everything', route(w, { broad: true }))
  await finish(w, 'ask', 'What is hashing?', route(w, { intent: 'lookup' }))
  await finish(w, 'ask', 'I think it sorts', route(w), 'leak_fallback')
  await finish(w, 'ask', 'I think it sorts', null)
  assert.equal((await events(w)).length, 0)
})

dbTest('routed ids that are not this student\'s active concepts are not recorded', async () => {
  const w = await world()
  const other = await world()
  await finish(w, 'ask', 'I think it sorts its keys', route(w, { conceptIds: [other.concept.id, crypto.randomUUID()] }))
  assert.equal((await events(w)).length, 0)
  await prisma.concept.update({ where: { id: w.concept.id }, data: { status: 'removed' } })
  await finish(w, 'ask', 'I think it sorts its keys', route(w))
  assert.equal((await events(w)).length, 0)
})

dbTest('a solve turn moves the ladder by the one event it is: an attempt climbs, a bare request does not', async () => {
  const w = await world()
  await finish(w, 'ask', 'Solve problem 3 for me', route(w, { intent: 'solve', hasAttempt: false, conceptIds: [] }))
  let state = await store.getTutorState(w.user.id, 'ask', w.thread.id)
  assert.deepEqual([state.rung, state.attempts, state.lowEffortTurns], [0, 0, 1])
  await finish(w, 'ask', 'I tried substituting x = 2 but the limits look wrong', route(w, { intent: 'solve', conceptIds: [] }))
  state = await store.getTutorState(w.user.id, 'ask', w.thread.id)
  assert.deepEqual([state.rung, state.attempts, state.lowEffortTurns], [1, 1, 0])
  // Lookups and explanations are not student turns on the ladder.
  await finish(w, 'ask', 'What is hashing?', route(w, { intent: 'lookup' }))
  assert.equal((await store.getTutorState(w.user.id, 'ask', w.thread.id)).rung, 1)
  assert.equal((await events(w)).length, 0)
})

dbTest('the worked example needs an attempt, then surrenders once: level 3 and rung 5', async () => {
  const w = await world()
  const none = turn.planAskTurn(await turn.loadAskState(w.user.id, w.thread.id), turn.WORKED_EXAMPLE_REQUEST, 'show_worked')
  assert.equal(none.ok, false)
  await finish(w, 'ask', 'I tried substituting x = 2 but the limits look wrong', route(w, { intent: 'solve' }))
  // The button's turn names no concept: the evidence goes to the concepts the conversation has been about.
  const done = await finish(w, 'show_worked', turn.WORKED_EXAMPLE_REQUEST, route(w, { intent: 'solve', hasAttempt: true, concepts: [], conceptIds: [] }))
  assert.equal(done.workedAllowed, true)
  const state = await store.getTutorState(w.user.id, 'ask', w.thread.id)
  assert.equal(state.rung, 5)
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].assistance, 3)
  assert.equal((rows[0].metadata as Record<string, unknown>).surrendered, true)
  // The next ordinary message is answered at structure at most, not another worked example.
  const planned = turn.planAskTurn(state, 'Now I will try it myself on my problem', 'ask')
  assert.ok(planned.ok && planned.plan.tutor.rung === 4 && planned.plan.tutor.attempt_rung === 4)
})

dbTest('a failed evidence write leaves the rung where it was', async () => {
  const w = await world()
  const before = await turn.loadAskState(w.user.id, w.thread.id)
  await finish(w, 'ask', 'I tried substituting x = 2 but the limits look wrong', route(w, { intent: 'solve', conceptIds: [] }))
  await finish(w, 'ask', 'And then I tried the other way round', route(w, { intent: 'solve', conceptIds: [] }))
  await finish(w, 'ask', 'And a third way of looking at the limits', route(w, { intent: 'solve', conceptIds: [] }))
  const rung3 = await turn.loadAskState(w.user.id, w.thread.id)
  assert.equal(rung3.rung, 3)
  const planned = turn.planAskTurn(rung3, 'A fourth go at the same limits', 'ask')
  assert.ok(planned.ok)
  const message = await reply(w, null)
  await assert.rejects(
    turn.finishAskTurn({
      userId: w.user.id,
      projectId: w.project.id,
      threadId: w.thread.id,
      messageId: message.id,
      plan: planned.plan,
      route: route(w, { intent: 'solve', conceptIds: [w.concept.id] }),
      stopReason: 'end_turn',
      // An unusable zone makes recordEvidence throw before the state is written.
      timeZone: 'Not/AZone',
    })
  )
  assert.equal((await turn.loadAskState(w.user.id, w.thread.id)).rung, 3)
  assert.equal(before.rung, 0)
})

// ------------------------------------------------------------------------------------------ the check card

async function withCard(w: World, conceptId: string | null = w.concept.id, attempted = true) {
  const stored = tutorMessage.toStoredTutor(route(w), { ...card, conceptName: conceptId ? 'Hash tables' : '' })
  if (!conceptId && stored.check) stored.check.conceptId = null
  // The student has tried, unless a test says otherwise: the answer and the grade both need an attempt.
  if (attempted && stored.check) stored.check.attempt = { text: 'an answer', idk: false }
  return reply(w, stored)
}

dbTest('the answer is shown to the card\'s owner only', async () => {
  const w = await world()
  const other = await world()
  const message = await withCard(w)
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: message.id }), { status: 'ok', answer: card.answer, explanation: card.explanation })
  assert.deepEqual(await check.revealAskCheck({ userId: other.user.id, messageId: message.id }), { status: 'not_found' })
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: crypto.randomUUID() }), { status: 'not_found' })
  const plain = await reply(w, null)
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: plain.id }), { status: 'not_found' })
})

dbTest('the answer is not returned before the student has tried, and a grade needs the attempt too', async () => {
  const w = await world()
  const message = await withCard(w, w.concept.id, false)
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: message.id }), { status: 'attempt_required' })
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: message.id, attempt: '   ' }), { status: 'attempt_required' })
  assert.deepEqual(await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', timeZone: 'UTC' }), { status: 'attempt_required' })
  assert.equal((await events(w)).length, 0)
  // Sending an attempt stores it and returns the answer; a later call without one still works (a reload).
  assert.deepEqual(await check.revealAskCheck({ userId: w.user.id, messageId: message.id, attempt: 'a table of buckets' }), { status: 'ok', answer: card.answer, explanation: card.explanation })
  assert.equal(tutorMessage.parseStoredTutor((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).tutor)?.check?.attempt?.text, 'a table of buckets')
  assert.equal((await check.revealAskCheck({ userId: w.user.id, messageId: message.id })).status, 'ok')
  assert.equal((await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'partly', timeZone: 'UTC' })).status, 'ok')
})

dbTest('"I don\'t know" is an attempt, and the first attempt stands', async () => {
  const w = await world()
  const message = await withCard(w, w.concept.id, false)
  assert.equal((await check.revealAskCheck({ userId: w.user.id, messageId: message.id, dontKnow: true })).status, 'ok')
  await check.revealAskCheck({ userId: w.user.id, messageId: message.id, attempt: 'a later answer' })
  const stored = tutorMessage.parseStoredTutor((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).tutor)
  assert.deepEqual(stored?.check?.attempt, { text: '', idk: true })
})

dbTest('a card graded Got it is level 2, self-graded, with the confidence tapped, and the thread is not told it holds a right answer', async () => {
  const w = await world()
  const message = await withCard(w)
  const result = await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', confidenceLevel: 'fairly', timeZone: 'UTC' })
  assert.deepEqual(result, { status: 'ok', recorded: true, grade: 'got_it' })
  const [row] = await events(w)
  assert.equal(row.source, 'ask_check')
  assert.equal(row.assistance, 2)
  assert.equal(row.score, 1)
  assert.equal(row.gradedBy, 'self')
  assert.equal(row.confidence, 0.75)
  assert.equal(row.itemKey, `ask:${w.thread.id}:${message.id}`)
  // A self-grade is not a verified answer: the thread's state is unchanged and a reply may not confirm anything.
  assert.equal((await store.getTutorState(w.user.id, 'ask', w.thread.id)).checkedCorrect, false)
  const planned = turn.planAskTurn(await turn.loadAskState(w.user.id, w.thread.id), 'Is my answer 12?', 'ask')
  assert.ok(planned.ok && planned.plan.tutor.final_allowed === false)
  // The browser's view of the stored card carries the grade and no answer.
  const view = tutorMessage.turnView(tutorMessage.parseStoredTutor((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).tutor))
  assert.equal(view?.check?.grade, 'got_it')
})

dbTest('Missed and Partly score 0 and 0.5 and do not unlock confirming', async () => {
  const w = await world()
  const missed = await withCard(w)
  const partly = await withCard(w)
  await check.recordAskCheck({ userId: w.user.id, messageId: missed.id, grade: 'missed', timeZone: 'UTC' })
  await check.recordAskCheck({ userId: w.user.id, messageId: partly.id, grade: 'partly', timeZone: 'UTC' })
  assert.deepEqual((await events(w)).map((row) => row.score).sort(), [0, 0.5])
  assert.equal((await store.getTutorState(w.user.id, 'ask', w.thread.id)).checkedCorrect, false)
})

dbTest('the first grade stands, and two taps at once record one', async () => {
  const w = await world()
  const message = await withCard(w)
  const results = await Promise.all([
    check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', timeZone: 'UTC' }),
    check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'missed', timeZone: 'UTC' }),
  ])
  assert.deepEqual(results.map((r) => r.status === 'ok' && r.recorded).sort(), [false, true])
  assert.equal((await events(w)).length, 1)
  assert.deepEqual(await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'missed', timeZone: 'UTC' }), { status: 'ok', recorded: false, grade: 'missed' })
})

dbTest('a card that names no concept is graded but filed under nothing', async () => {
  const w = await world()
  const message = await withCard(w, null)
  assert.deepEqual(await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', timeZone: 'UTC' }), { status: 'ok', recorded: false, grade: 'got_it' })
  assert.equal((await events(w)).length, 0)
  const view = tutorMessage.turnView(tutorMessage.parseStoredTutor((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).tutor))
  assert.equal(view?.check?.grade, 'got_it')
})

dbTest('another student\'s card, or a reply with no card, is not found', async () => {
  const w = await world()
  const other = await world()
  const message = await withCard(w)
  assert.deepEqual(await check.recordAskCheck({ userId: other.user.id, messageId: message.id, grade: 'got_it', timeZone: 'UTC' }), { status: 'not_found' })
  const plain = await reply(w, null)
  assert.deepEqual(await check.recordAskCheck({ userId: w.user.id, messageId: plain.id, grade: 'got_it', timeZone: 'UTC' }), { status: 'not_found' })
  assert.equal((await events(w)).length, 0)
})

dbTest('a grade that could not be filed can be given again', async () => {
  const w = await world()
  const message = await withCard(w)
  await assert.rejects(check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', timeZone: 'Not/AZone' }))
  assert.deepEqual(await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', timeZone: 'UTC' }), { status: 'ok', recorded: true, grade: 'got_it' })
})

// ------------------------------------------------------------------------------------------ the exam guard

async function exam(w: World, status: 'in_progress' | 'submitted', questions: unknown, deadlineAt: Date | null = new Date(Date.now() + 3_600_000), projectId = w.project.id) {
  const sample = await prisma.sampleExam.create({
    data: { projectId, name: 'Mock', questions: questions as never, durationMinutes: 60, difficultyLevel: 'medium', topicsCovered: [] },
  })
  await prisma.examSubmission.create({ data: { sampleExamId: sample.id, userId: w.user.id, answers: {}, status, startedAt: new Date(), deadlineAt } })
  return sample.id
}

dbTest('the open exam\'s questions are the in-progress attempts of this course that have time left', async () => {
  const w = await world()
  const elsewhere = await prisma.project.create({ data: { userId: w.user.id, name: 'Other course' } })
  await exam(w, 'in_progress', [{ question_text: 'Which structure gives constant average lookup?', options: [{ id: 'A', text: 'Hash table' }] }])
  await exam(w, 'submitted', [{ question_text: 'A submitted exam question' }])
  await exam(w, 'in_progress', [{ question_text: 'An expired attempt question' }], new Date(Date.now() - 60_000))
  await exam(w, 'in_progress', [{ question_text: 'A question of another course' }], new Date(Date.now() + 3_600_000), elsewhere.id)
  const texts = await guard.openExamQuestionTexts(w.user.id, w.project.id)
  assert.deepEqual(texts, ['Which structure gives constant average lookup?', 'Which structure gives constant average lookup? Hash table'])
  assert.deepEqual(await guard.openExamQuestionTexts((await world()).user.id, w.project.id), [])
})

dbTest('"I don\'t know" then Got it counts as Missed: score 0, no right answer seen by the thread', async () => {
  const w = await world()
  const message = await withCard(w)
  const result = await check.recordAskCheck({ userId: w.user.id, messageId: message.id, grade: 'got_it', dontKnow: true, timeZone: 'UTC' })
  assert.deepEqual(result, { status: 'ok', recorded: true, grade: 'missed' })
  const [row] = await events(w)
  assert.equal(row.score, 0)
  assert.equal((row.metadata as Record<string, unknown>).grade, 'missed')
  assert.equal((await store.getTutorState(w.user.id, 'ask', w.thread.id)).checkedCorrect, false)
  const view = tutorMessage.turnView(tutorMessage.parseStoredTutor((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).tutor))
  assert.equal(view?.check?.grade, 'missed')
})

dbTest('a new problem in the thread starts its ladder again once the reply is stored; a repeated attempt does not climb', async () => {
  const w = await world()
  const solve = (over: Partial<AskRoute> = {}) => route(w, { intent: 'solve', conceptIds: [], hasAttempt: true, ...over })
  await finish(w, 'ask', 'I tried dividing 48 by 16 and got 3 but the ratio looks wrong', solve())
  await finish(w, 'ask', 'And I also tried multiplying the teeth, which gave 768 and looks odd', solve())
  assert.equal((await turn.loadAskState(w.user.id, w.thread.id)).rung, 2)
  // The same attempt sent again does not climb.
  await finish(w, 'ask', 'i tried dividing 48 by 16 and got 3 but the ratio looks wrong', solve(), 'end_turn', [
    'I tried dividing 48 by 16 and got 3 but the ratio looks wrong',
    'And I also tried multiplying the teeth, which gave 768 and looks odd',
  ])
  assert.equal((await turn.loadAskState(w.user.id, w.thread.id)).rung, 2)
  // A different problem: planned from rung 0, and the stored ladder starts again.
  const other = 'A savings account holds 1,500 dollars and pays 4 percent interest once a year. What is the balance after 5 years?'
  const before = await turn.loadAskState(w.user.id, w.thread.id)
  const planned = turn.planAskTurn(before, other, 'ask', ['I tried dividing 48 by 16 and got 3 but the ratio looks wrong'])
  assert.ok(planned.ok && planned.plan.fresh && planned.plan.tutor.rung === 0)
  const message = await reply(w, null)
  await turn.finishAskTurn({
    userId: w.user.id,
    projectId: w.project.id,
    threadId: w.thread.id,
    messageId: message.id,
    plan: planned.plan,
    route: solve({ hasAttempt: false }),
    stopReason: 'end_turn',
    timeZone: 'UTC',
  })
  const after = await store.getTutorState(w.user.id, 'ask', w.thread.id)
  // Reset, then the new problem's own request: low effort 1, no attempts, no rung.
  assert.deepEqual([after.rung, after.maxRung, after.attempts, after.lowEffortTurns, after.checkedCorrect], [0, 0, 0, 1, false])
})

// ------------------------------------------------------------------------------------------ the understand counter

const counter = (w: World) =>
  prisma.tutorState.findUnique({ where: { userId_scope_scopeKey: { userId: w.user.id, scope: 'ask', scopeKey: w.thread.id } }, select: { understandNoAttempt: true, understandConcepts: true } })

const planNext = async (w: World, question: string) => {
  const planned = turn.planAskTurn(await turn.loadAskState(w.user.id, w.thread.id), question, 'ask', [], await turn.loadUnderstand(w.user.id, w.thread.id))
  assert.ok(planned.ok)
  return planned.plan
}

dbTest('a concept with no evidence is band 0: it explains after one non-attempt turn', async () => {
  const w = await world()
  assert.equal((await planNext(w, 'Explain hash tables')).tutor.understand_mode, 'commit')
  await finish(w, 'ask', 'Explain hash tables', route(w, { hasAttempt: false }))
  assert.deepEqual(await counter(w), { understandNoAttempt: 1, understandConcepts: [w.concept.id] })
  assert.equal((await planNext(w, 'idk')).tutor.understand_mode, 'explain_short')
})

dbTest('explain_short records level 3 on the routed concepts and resets the count', async () => {
  const w = await world()
  await finish(w, 'ask', 'Explain hash tables', route(w, { hasAttempt: false }))
  assert.equal((await events(w)).length, 0)
  await finish(w, 'ask', 'idk', route(w, { hasAttempt: false }))
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].assistance, 3)
  assert.equal(rows[0].score, 0)
  assert.equal(rows[0].conceptId, w.concept.id)
  assert.deepEqual(await counter(w), { understandNoAttempt: 0, understandConcepts: [w.concept.id] })
})
