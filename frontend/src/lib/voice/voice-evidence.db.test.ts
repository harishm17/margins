/**
 * A spoken answer becomes learner-model evidence (spec §5.8), against a real, migrated Postgres
 * (DATABASE_URL). The grader is a stub: no model is called.
 */
import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let tools: typeof import('./tools')
let beginVoiceTurn: typeof import('./teach-tools').beginVoiceTurn
let available = false
const userIds: string[] = []
const realFetch = globalThis.fetch

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  tools = await import('./tools')
  ;({ beginVoiceTurn } = await import('./teach-tools'))
  available = await prisma.$queryRaw`SELECT hinted_questions FROM voice_drill_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
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

/** The grader answers every question with the given share of the points. */
function stubGrader(share: number) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { questions?: unknown[] }
    const count = body.questions?.length ?? 1
    const graded = Array.from({ length: count }, (_, index) => ({
      question_index: index,
      question_type: 'short_answer',
      points_possible: 1,
      points_earned: share,
      is_correct: share >= 0.7,
      feedback: 'ok',
      needs_review: false,
    }))
    return new Response(JSON.stringify({ graded_questions: graded, total_points: count, earned_points: share * count, overall_score: share * 100, needs_review: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

async function world() {
  const user = await prisma.user.create({ data: { email: `vo-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const concept = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'C', summary: 's', kind: 'concept', orderIndex: 0 },
  })
  const retired = await prisma.concept.create({
    data: { projectId: project.id, topicId: topic.id, name: 'Old', summary: 's', kind: 'concept', orderIndex: 1, status: 'removed' },
  })
  const question = (text: string, conceptIds: string[]) => ({
    question_type: 'conceptual',
    question_text: text,
    sample_answer: 'The answer.',
    key_points: ['point'],
    concept_ids: conceptIds,
    topic_id: topic.id,
  })
  const session = await prisma.voiceDrillSession.create({
    data: {
      userId: user.id,
      projectId: project.id,
      topicId: topic.id,
      questionSet: [question('q0', [concept.id]), question('q1', [concept.id]), question('q2', [retired.id]), question('q3', [])],
    },
  })
  return { user, project, topic, concept, session }
}

type World = Awaited<ReturnType<typeof world>>
/** One call is one student turn: what the student "said" is the answer in the arguments, recorded the way the route does. */
const run = async (w: World, name: string, args: unknown) => {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const turn = await beginVoiceTurn(w.session.id, typeof record.user_answer === 'string' ? record.user_answer : '')
  return tools.executeVoiceTool({ sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn }, name, args)
}
const events = (w: World) => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'voice' }, orderBy: { itemKey: 'asc' } })

dbTest('a wrong answer comes back with the pages of the question\'s concepts, a right one does not', async () => {
  const w = await world()
  const material = await prisma.material.create({ data: { projectId: w.project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: w.concept.id, text: 'A claim.', quote: 'A claim.', materialId: material.id, orderIndex: 0, pageStart: 4, pageEnd: 6 } })
  await prisma.conceptClaim.create({ data: { conceptId: w.concept.id, text: 'No page.', quote: 'No page.', materialId: material.id, orderIndex: 1 } })
  stubGrader(0)
  const wrong = await run(w, 'record_answer', { question_index: 0, user_answer: 'no idea' })
  const evaluation = wrong.events.find((event) => event.type === 'evaluation')
  assert.ok(evaluation && evaluation.type === 'evaluation')
  assert.deepEqual(evaluation.lookLinks, [{ label: 'pp. 4-6', href: `/api/materials/${material.id}/file#page=4` }])
  assert.equal(JSON.stringify(wrong.output).includes('/file#page'), false, 'the links go to the browser, not to the model')
  // Finding 84: so does the answer it was graded against, for the summary. The coach is not handed it to say.
  assert.equal(evaluation.answer, 'The answer.')
  assert.equal(JSON.stringify(wrong.output).includes('The answer.'), false, 'the answer goes to the browser, not to the model')
  // A question with no concepts has no pages; a right answer is not asked to look again.
  const none = await run(w, 'record_answer', { question_index: 3, user_answer: 'no idea' })
  assert.equal(none.events.find((event) => event.type === 'evaluation' && event.lookLinks) === undefined, true)
  stubGrader(1)
  const right = await run(w, 'record_answer', { question_index: 1, user_answer: 'keys map to buckets' })
  assert.equal(right.events.find((event) => event.type === 'evaluation' && (event.lookLinks || event.answer)) === undefined, true)
})

dbTest('a spoken answer with no hint is level 0 evidence with the session key and confidence', async () => {
  stubGrader(1)
  const w = await world()
  const out = await run(w, 'record_answer', { question_index: 0, user_answer: 'keys map to buckets', confidence: 0.8 })
  assert.equal(out.isError, false)
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].assistance, 0)
  assert.equal(rows[0].score, 1)
  assert.equal(rows[0].confidence, 0.8)
  assert.equal(rows[0].sessionKey, `voice:${w.session.id}`)
  assert.equal(rows[0].itemKey, `voice:${w.session.id}:0`)
  assert.equal(rows[0].conceptId, w.concept.id)
  assert.equal(rows[0].gradedBy, 'model')
})

dbTest('hint before an answer asks for a try', async () => {
  stubGrader(1)
  const w = await world()
  const hint = await run(w, 'get_hint', { question_index: 0 })
  assert.equal(hint.isError, false)
  assert.equal((hint.output as Record<string, unknown>).action, 'ask_for_try')
  // No nudge, nothing recorded as a hint, and the question is still open for a first try.
  assert.equal(JSON.stringify(hint.output).includes('hint'), false)
  assert.deepEqual((await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: w.session.id } })).hintedQuestions, [])
  await run(w, 'record_answer', { question_index: 0, user_answer: 'keys map to buckets' })
  assert.deepEqual((await events(w)).map((row) => [row.assistance, row.score]), [[0, 1]])
  // After the try the hint is given, and it is recorded.
  const given = await run(w, 'get_hint', { question_index: 0 })
  assert.notEqual((given.output as Record<string, unknown>).action, 'ask_for_try')
  assert.deepEqual((await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: w.session.id } })).hintedQuestions, [0])
})

dbTest('answer after hint is level 1', async () => {
  stubGrader(1)
  const w = await world()
  // A hint recorded before the first answer (a session from before the try-first rule): the answer was not a first try.
  await prisma.voiceDrillSession.update({ where: { id: w.session.id }, data: { hintedQuestions: [0] } })
  await run(w, 'record_answer', { question_index: 0, user_answer: 'keys map to buckets' })
  // A hint on question 0 does not assist question 1.
  await run(w, 'record_answer', { question_index: 1, user_answer: 'keys map to buckets' })
  const rows = await events(w)
  assert.deepEqual(rows.map((row) => [row.itemKey.split(':').pop(), row.assistance, row.score]), [['0', 1, 0], ['1', 0, 1]])
})

dbTest('voice idk is level 0 score 0', async () => {
  const w = await world()
  const material = await prisma.material.create({ data: { projectId: w.project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: w.concept.id, text: 'A claim.', quote: 'A claim.', materialId: material.id, orderIndex: 0, pageStart: 4 } })
  globalThis.fetch = (async () => assert.fail('an "I don\'t know" is not graded')) as typeof fetch
  const said = await run(w, 'record_answer', { question_index: 0, user_answer: "I don't know", idk: true, confidence: 0.9 })
  assert.equal(said.isError, false)
  const output = said.output as Record<string, unknown>
  assert.equal(output.is_correct, false)
  assert.equal(output.score, 0)
  // The coach is told where the idea is, and not what it is.
  assert.deepEqual(output.where_to_look, ['p. 4'])
  assert.equal(JSON.stringify(output).includes('The answer.'), false)
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].assistance, rows[0].score, rows[0].confidence], [0, 0, null])
  assert.deepEqual([(rows[0].metadata as Record<string, unknown>).idk, (rows[0].metadata as Record<string, unknown>).missKind], [true, 'cue_miss'])
  const attempt = await prisma.voiceDrillAttempt.findFirstOrThrow({ where: { sessionId: w.session.id, questionIndex: 0 } })
  assert.deepEqual([attempt.isCorrect, attempt.score], [false, 0])
  // The same detector hears it without the flag, and a spoken idk cannot be made up: nothing said, nothing recorded.
  const typed = await run(w, 'record_answer', { question_index: 1, user_answer: 'no idea' })
  assert.equal(typed.isError, false)
  assert.equal((typed.output as Record<string, unknown>).score, 0)
  assert.equal((await events(w)).length, 2)
  const silent = await tools.executeVoiceTool({ sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn: 99 }, 'record_answer', { question_index: 3, idk: true })
  assert.equal(silent.isError, true)
})

dbTest('answering the same question again adds no evidence: the coach has already given feedback', async () => {
  stubGrader(1)
  const w = await world()
  await run(w, 'record_answer', { question_index: 0, user_answer: 'first' })
  stubGrader(0)
  await run(w, 'record_answer', { question_index: 0, user_answer: 'second' })
  const rows = await events(w)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, 1)
})

dbTest('an answer is recorded against the question the server asked, whatever index the coach passes', async () => {
  // Bug: the earlier prompts ask the model for question_index and the server believed it, so a coach that miscounted
  // had the answer graded against another question's key and stored under it.
  stubGrader(1)
  const w = await world()
  await run(w, 'get_next_question', {}) // serves question 0
  await run(w, 'record_answer', { question_index: 2, user_answer: 'keys map to buckets' })
  const attempts = await prisma.voiceDrillAttempt.findMany({ where: { sessionId: w.session.id } })
  assert.deepEqual(attempts.map((attempt) => [attempt.questionIndex, attempt.questionText]), [[0, 'q0']])
  assert.deepEqual((await events(w)).map((row) => row.itemKey), [`voice:${w.session.id}:0`])
})

dbTest('an answer whose first recording failed after the attempt was stored gets its evidence when it is recorded again', async () => {
  // Bug: evidence was written only by the call whose insert was first, so a failure between the insert and the
  // evidence lost the evidence for good. The row below is what such a failed first try left behind.
  stubGrader(1)
  const w = await world()
  await prisma.voiceDrillAttempt.create({
    data: { sessionId: w.session.id, userId: w.user.id, topicId: w.topic.id, questionIndex: 0, questionType: 'conceptual', questionText: 'q0', expectedAnswer: {}, userAnswer: 'keys map to buckets', isCorrect: true, score: 1 },
  })
  await run(w, 'record_answer', { question_index: 0, user_answer: 'keys map to buckets' })
  assert.deepEqual((await events(w)).map((row) => [row.itemKey, row.score]), [[`voice:${w.session.id}:0`, 1]])
})

dbTest('work handed to the turn (signal, schedule, evidence) is done once the turn has waited for it', async () => {
  stubGrader(1)
  const w = await world()
  const turn = await beginVoiceTurn(w.session.id, 'keys map to buckets')
  const deferred: Promise<void>[] = []
  const out = await tools.executeVoiceTool(
    { sessionId: w.session.id, userId: w.user.id, timeZone: 'UTC', turn, defer: (work) => void deferred.push(work) },
    'record_answer',
    { question_index: 0 }
  )
  assert.equal(out.isError, false)
  assert.equal(deferred.length, 1)
  await Promise.all(deferred)
  assert.equal((await events(w)).length, 1)
  assert.equal(await prisma.reviewSchedule.count({ where: { userId: w.user.id, topicId: w.topic.id } }), 1)
})

dbTest('two answers to the same question arriving together write one piece of evidence', async () => {
  stubGrader(1)
  const w = await world()
  await Promise.all([
    run(w, 'record_answer', { question_index: 0, user_answer: 'first' }),
    run(w, 'record_answer', { question_index: 0, user_answer: 'second' }),
  ])
  assert.equal((await events(w)).length, 1)
  assert.equal(await prisma.voiceDrillAttempt.count({ where: { sessionId: w.session.id } }), 1)
})

dbTest('asking for a hint twice records it once', async () => {
  stubGrader(0)
  const w = await world()
  await run(w, 'record_answer', { question_index: 0, user_answer: 'a try' })
  await run(w, 'get_hint', { question_index: 0 })
  await run(w, 'get_hint', { question_index: 0 })
  const session = await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: w.session.id } })
  assert.deepEqual(session.hintedQuestions, [0])
})

dbTest('an evidence failure never takes the recorded answer away', async () => {
  stubGrader(1)
  const w = await world()
  // A concept id that is not a concept in this project is filtered out, not an error.
  await prisma.voiceDrillSession.update({
    where: { id: w.session.id },
    data: { questionSet: [{ question_type: 'conceptual', question_text: 'q', sample_answer: 'a', key_points: ['p'], concept_ids: ['not-a-concept'], topic_id: w.topic.id }] },
  })
  const out = await run(w, 'record_answer', { question_index: 0, user_answer: 'a' })
  assert.equal(out.isError, false)
  assert.equal(await prisma.voiceDrillAttempt.count({ where: { sessionId: w.session.id } }), 1)
})
