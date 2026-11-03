/**
 * The source reader and its evidence against a real, migrated Postgres (DATABASE_URL). The AI service is a
 * stub. Skipped when no database with the margin_notes table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { ReaderTutorRequest } from '@/lib/ai-service/tutor'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let reader: typeof import('./load-reader')
let server: typeof import('./reader-server')
let warmup: typeof import('@/lib/learning/warmup-session')
let available = false
const realFetch = globalThis.fetch

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  reader = await import('./load-reader')
  server = await import('./reader-server')
  warmup = await import('@/lib/learning/warmup-session')
  available = await prisma.$queryRaw`SELECT 1 FROM margin_notes LIMIT 1`.then(
    () => true,
    () => false
  )
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/status/ai')) return Response.json({ available: true })
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
    return realFetch(input, init)
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  if (available) await prisma.$disconnect()
})

const SHARED_1 = 'Two keys that land in the same bucket collide, and the table must decide where the second one goes.'
const SHARED_2 = 'Chaining keeps every colliding entry in a list that hangs off the bucket, so a lookup walks that list.'

/**
 * A topic read from one PDF of four chunks under two headings. Chunks 0 and 1 overlap by a sentence, as the
 * chunker makes them. Concepts hold one claim each on chunks 0 and 2 (and a third concept on chunk 3).
 */
async function world(label: string, options: { concepts?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({
    data: { projectId: project.id, category: 'lecture_notes', filename: 'hashing.pdf', gcsPath: `e2e/${label}.pdf`, sizeBytes: BigInt(10), validationStatus: 'valid' },
  })
  const texts = [
    `# Hashing\n\nA hash function maps a key to a bucket index. ${SHARED_1}`,
    `${SHARED_1} Open addressing probes for the next free bucket.`,
    `## Chaining\n\n${SHARED_2} The load factor is the number of entries over the number of buckets.`,
    '## Resizing\n\nWhen the load factor grows, the table is rebuilt with more buckets.',
  ]
  const headings = ['Hashing', 'Hashing', 'Chaining', 'Resizing']
  const chunks = []
  for (const [index, chunkText] of texts.entries()) {
    chunks.push(
      await prisma.materialChunk.create({
        data: { materialId: material.id, chunkText, chunkIndex: index, pageStart: index < 2 ? 3 : 4 + index, pageEnd: index < 2 ? 3 : 4 + index, sectionHierarchy: headings[index] },
        select: { id: true },
      })
    )
  }
  await prisma.topicSource.create({ data: { topicId: topic.id, materialId: material.id, chunkIndexStart: 0, chunkIndexEnd: 3, role: 'primary' } })

  const concepts: { id: string; name: string }[] = []
  if (options.concepts !== false) {
    for (const [orderIndex, spec] of [
      { name: 'Hash function', chunk: 0 },
      { name: 'Collision', chunk: 2 },
      { name: 'Resizing', chunk: 3 },
    ].entries()) {
      const concept = await prisma.concept.create({
        data: { projectId: project.id, topicId: topic.id, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] },
        select: { id: true, name: true },
      })
      concepts.push(concept)
      await prisma.conceptClaim.create({
        data: { conceptId: concept.id, text: `${spec.name} claim.`, quote: `quote of ${spec.name}`, materialId: material.id, chunkId: chunks[spec.chunk].id, pageStart: 3, orderIndex: 0 },
      })
    }
    await prisma.topicContent.create({
      data: {
        topicId: topic.id,
        contentType: 'concept_prompts',
        contentData: { focus_questions: [{ objective_index: 0, question: 'How are two keys in one bucket handled?', chunk_id: chunks[2].id }], recall_prompts: [] },
      },
    })
  }
  return { user, project, topic, material, chunks, concepts }
}

const skip = { skip: !process.env.DATABASE_URL }

test('the reader strips overlap, keeps document order and dividers', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-order')
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.ok(data)
  assert.equal(data.files.length, 1)
  const [file] = data.files
  assert.equal(file.filename, 'hashing.pdf')
  assert.equal(file.pdf, true)
  assert.deepEqual(file.passages.map((p) => p.chunkId), w.chunks.map((c) => c.id))
  // The sentence the second chunk repeats is gone from it, and stays in the first.
  assert.ok(file.passages[0].text.includes(SHARED_1))
  assert.equal(file.passages[1].text.includes(SHARED_1), false)
  assert.ok(file.passages[1].text.startsWith('Open addressing'))
  // The page divider shows when the page changes: above the first passage, not above its overlapping neighbour.
  assert.deepEqual(file.passages.map((p) => p.divider), [3, null, 6, 7])
})

test('missed warm-up concepts mark their passages Focus here and hide nothing', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-focus')
  const questions = w.concepts.flatMap((concept, n) => [
    { question_type: 'true_false', question_text: `Statement ${n}`, correct_answer: true, explanation: 'x', points: 1, difficulty: ['easy', 'medium', 'hard'][n], mode: 'recall', concept_ids: [concept.id] },
  ])
  await prisma.topicQuiz.create({ data: { topicId: w.topic.id, kind: 'warmup', questions } })

  // Before the warm-up nothing is marked.
  const before = await reader.loadReader(w.user.id, w.topic.id)
  assert.equal(before?.focusCount, 0)

  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  while (state.status === 'asking') {
    // Wrong on the question about Hash function, right and sure on the rest.
    const wrong = /Statement 0/.test(state.question.question_text)
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: wrong ? 'false' : 'true', confidence: 0.95, confidenceLevel: 'certain' }, timeZone: 'UTC' })
    if (result.status !== 'ok') throw new Error(result.status)
    state = result.state
  }
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.ok(data)
  const passages = data.files.flatMap((f) => f.passages)
  assert.deepEqual(passages.filter((p) => p.focus).map((p) => p.chunkId), [w.chunks[0].id])
  // Nothing is hidden: every passage is there with its text.
  assert.equal(passages.length, 4)
  assert.ok(passages.every((p) => p.text.trim().length > 0))
  assert.equal(data.focusCount, 1)
})

test('one before-you-go-on check per section with a claim; the claim text stays on the server', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-checks')
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.ok(data)
  // Sections: Hashing (chunks 0-1, claim on 0), Chaining (chunk 2, claim on 2, the focus question points here), Resizing (chunk 3).
  assert.deepEqual(data.checks.map((c) => c.afterChunkId), [w.chunks[1].id, w.chunks[2].id, w.chunks[3].id])
  assert.deepEqual(data.checks.map((c) => c.kind), ['claim', 'focus', 'claim'])
  assert.equal(data.checks[1].question, 'How are two keys in one bucket handled?')
  assert.equal(data.checks[0].question, 'What does the reading say about Hash function?')
  // Neither the claim nor its quote is sent with the reading: the source is asked for when the student shows it.
  assert.equal(JSON.stringify(data).includes('Hash function claim.'), false)
  assert.equal(JSON.stringify(data).includes('quote of Hash function'), false)
  const source = await server.revealCheckSource({ userId: w.user.id, topicId: w.topic.id, claimId: data.checks[0].claimId })
  assert.deepEqual(source, { quote: 'quote of Hash function', pageStart: 3 })
  const other = await world('rd-checks-other')
  assert.equal(await server.revealCheckSource({ userId: other.user.id, topicId: w.topic.id, claimId: data.checks[0].claimId }), null)
  assert.equal(data.focusQuestions.length, 1)
  assert.equal(data.focusQuestions[0].chunkId, w.chunks[2].id)
})

test('a topic without concepts reads with no marks and no checks', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-legacy', { concepts: false })
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.ok(data)
  assert.equal(data.files[0].passages.length, 4)
  assert.deepEqual(data.checks, [])
  assert.deepEqual(data.focusQuestions, [])
  assert.equal(data.focusCount, 0)
})

test('a topic with no text to read has no files, and a stranger gets nothing', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-empty')
  const other = await world('rd-other')
  await prisma.topicSource.deleteMany({ where: { topicId: w.topic.id } })
  assert.deepEqual((await reader.loadReader(w.user.id, w.topic.id))?.files, [])
  assert.equal(await reader.loadReader(other.user.id, w.topic.id), null)
})

test('a topic planned before sources existed reads from its mapped chunks', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-mapped', { concepts: false })
  await prisma.topicSource.deleteMany({ where: { topicId: w.topic.id } })
  await prisma.topicChunkMapping.createMany({ data: [w.chunks[2].id, w.chunks[0].id].map((chunkId, n) => ({ topicId: w.topic.id, chunkId, relevanceScore: 0.9 - n * 0.1 })) })
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.deepEqual(data?.files[0].passages.map((p) => p.chunkId), [w.chunks[0].id, w.chunks[2].id])
})

test('explain this requires a take first', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-explain')
  const asked: ReaderTutorRequest[] = []
  const ask = async (request: ReaderTutorRequest) => {
    asked.push(request)
    return { reply: 'It describes what happens to two keys in one bucket.', check_question: 'Which list holds them?' }
  }
  const base = { userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, timeZone: 'UTC' }

  // Nothing is explained to a student who has written nothing, or a few letters.
  for (const take of ['', '   ', 'huh', 'seven c']) {
    const refused = await server.explainPassage({ ...base, take, cantParse: false }, ask)
    assert.equal(refused.status, 'invalid')
  }
  assert.equal(asked.length, 0)
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id } }), 0)

  // Eight characters is an attempt.
  const first = await server.explainPassage({ ...base, take: 'eight ch', cantParse: false }, ask)
  assert.equal(first.status, 'ok')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].rung, 1)
  assert.equal(asked[0].student_take, 'eight ch')
  assert.equal(asked[0].cant_parse, false)
  // The claims of this passage's concepts go along, for the leak check.
  assert.deepEqual(asked[0].claims.map((c) => c.text), ['Collision claim.'])

  // The one-tap answer is an attempt too, and the next question on the passage opens the next rung.
  const second = await server.explainPassage({ ...base, take: '', cantParse: true }, ask)
  assert.equal(second.status, 'ok')
  assert.equal(asked[1].student_take, "I can't parse any of it")
  assert.equal(asked[1].cant_parse, true)
  assert.equal(asked[1].rung, 2)

  // The exchange is a margin note of kind question, level-3 evidence follows, and the memory is left alone.
  const notes = await prisma.marginNote.findMany({ where: { userId: w.user.id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(notes.map((n) => n.kind), ['question', 'question'])
  assert.equal(notes[0].text, 'eight ch')
  assert.deepEqual(notes[0].reply, { reply: 'It describes what happens to two keys in one bucket.', checkQuestion: 'Which list holds them?', rung: 1 })
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(events.length, 2)
  assert.ok(events.every((e) => e.source === 'reader' && e.assistance === 3 && e.score === 0 && e.conceptId === w.concepts[1].id))
  const memory = await prisma.conceptMemory.findMany({ where: { userId: w.user.id } })
  assert.ok(memory.every((m) => m.nUnassisted === 0 && m.lastAssistedAt !== null))
})

test('explain this on a passage of a topic without concepts writes the note and no evidence', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-explain-legacy', { concepts: false })
  const ask = async () => ({ reply: 'It is about buckets.', check_question: 'What is a bucket?' })
  const result = await server.explainPassage({ userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[0].id, take: 'it says something about hashing', cantParse: false, timeZone: 'UTC' }, ask)
  assert.equal(result.status, 'ok')
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id } }), 1)
})

test('explain this keeps no note when the tutor cannot answer, and refuses a passage that is not theirs', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-explain-down')
  const other = await world('rd-explain-other')
  const down = async () => {
    throw new Error('tutor down')
  }
  await assert.rejects(server.explainPassage({ userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[0].id, take: 'a long enough take', cantParse: false, timeZone: 'UTC' }, down))
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id } }), 0)
  const ask = async () => ({ reply: 'x', check_question: 'y?' })
  const foreign = await server.explainPassage({ userId: other.user.id, topicId: w.topic.id, chunkId: w.chunks[0].id, take: 'a long enough take', cantParse: false, timeZone: 'UTC' }, ask)
  assert.equal(foreign.status, 'not_found')
  // A passage of another course is not reachable through this topic.
  const crossed = await server.explainPassage({ userId: w.user.id, topicId: w.topic.id, chunkId: other.chunks[0].id, take: 'a long enough take', cantParse: false, timeZone: 'UTC' }, ask)
  assert.equal(crossed.status, 'not_found')
})

test('a before-you-go-on check is self-graded level 2 evidence, recorded once per claim', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-check')
  const claim = await prisma.conceptClaim.findFirstOrThrow({ where: { conceptId: w.concepts[0].id } })
  const done = await server.recordReaderCheck({ userId: w.user.id, topicId: w.topic.id, claimId: claim.id, grade: 'partly', timeZone: 'UTC' })
  assert.deepEqual(done, { status: 'ok', recorded: true })
  // The reader hands the grade back, so a new browser session does not ask the same check again.
  const shown = await reader.loadReader(w.user.id, w.topic.id)
  assert.equal(shown?.checks.find((check) => check.claimId === claim.id)?.graded, 'partly')
  assert.equal(shown?.checks.filter((check) => check.graded !== null).length, 1)
  // Graded again in a later session: said so, and not counted twice.
  const again = await server.recordReaderCheck({ userId: w.user.id, topicId: w.topic.id, claimId: claim.id, grade: 'got_it', timeZone: 'UTC' })
  assert.deepEqual(again, { status: 'ok', recorded: false })
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(events.length, 1)
  assert.equal(events[0].assistance, 2)
  assert.equal(events[0].gradedBy, 'self')
  assert.equal(events[0].score, 0.5)
  assert.equal(events[0].source, 'reader')
  // Level 2 never counts as an unassisted review of the memory.
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[0].id } } })
  assert.equal(memory.nUnassisted, 0)
  assert.equal(memory.nAssisted, 1)
  // Someone else's claim is not found.
  const other = await world('rd-check-other')
  assert.equal((await server.recordReaderCheck({ userId: other.user.id, topicId: w.topic.id, claimId: claim.id, grade: 'got_it', timeZone: 'UTC' })).status, 'not_found')
})

test('margin notes persist and belong to their owner', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-notes')
  const other = await world('rd-notes-other')
  await prisma.marginNote.create({ data: { userId: w.user.id, topicId: w.topic.id, materialId: w.material.id, chunkId: w.chunks[1].id, kind: 'note', text: 'Remember the probe order.' } })
  const mine = await reader.loadMarginNotes(w.user.id, w.topic.id)
  assert.deepEqual(mine.map((n) => [n.chunkId, n.kind, n.text]), [[w.chunks[1].id, 'note', 'Remember the probe order.']])
  assert.deepEqual(await reader.loadMarginNotes(other.user.id, w.topic.id), [])
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.equal(data?.notes.length, 1)
})

test('the focus count is worked out from claims and chunk ids, and matches the reader', skip, async (t) => {
  if (!available) return t.skip('no database')
  const focus = await import('./focus')
  const w = await world('rd-count')
  await prisma.topicQuiz.create({
    data: {
      topicId: w.topic.id,
      kind: 'warmup',
      questions: w.concepts.map((concept, n) => ({ question_type: 'true_false', question_text: `Statement ${n}`, correct_answer: true, explanation: 'x', points: 1, difficulty: ['easy', 'medium', 'hard'][n], mode: 'recall', concept_ids: [concept.id] })),
    },
  })
  assert.equal(await focus.countFocusPassages(w.user.id, w.topic.id), 0)
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  while (state.status === 'asking') {
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'false', confidence: 0.75, confidenceLevel: 'fairly' }, timeZone: 'UTC' })
    if (result.status !== 'ok') throw new Error(result.status)
    state = result.state
  }
  const count = await focus.countFocusPassages(w.user.id, w.topic.id)
  assert.equal(count, 3)
  assert.equal((await reader.loadReader(w.user.id, w.topic.id))?.focusCount, count)
  assert.equal(((await focus.withFocusCount(w.user.id, w.topic.id, state as never)) as { focusCount?: number }).focusCount, 3)
})

test('the focus count follows claims on a chunk that was only overlap, as the reader does', skip, async (t) => {
  if (!available) return t.skip('no database')
  const focus = await import('./focus')
  const w = await world('rd-count-merged')
  // Chunk 1 is nothing but the sentence chunk 0 ends with, so the reader merges it into chunk 0; the second concept's claim sits on it, beside the first concept's claim on chunk 0.
  await prisma.materialChunk.update({ where: { id: w.chunks[1].id }, data: { chunkText: SHARED_1 } })
  await prisma.conceptClaim.updateMany({ where: { conceptId: w.concepts[1].id }, data: { chunkId: w.chunks[1].id } })
  await prisma.topicQuiz.create({
    data: {
      topicId: w.topic.id,
      kind: 'warmup',
      questions: w.concepts.map((concept, n) => ({ question_type: 'true_false', question_text: `Statement ${n}`, correct_answer: true, explanation: 'x', points: 1, difficulty: ['easy', 'medium', 'hard'][n], mode: 'recall', concept_ids: [concept.id] })),
    },
  })
  let state = await warmup.startWarmup({ userId: w.user.id, topicId: w.topic.id })
  while (state.status === 'asking') {
    const result = await warmup.answerWarmup({ userId: w.user.id, topicId: w.topic.id, sessionId: state.sessionId, index: state.index, answer: { answer: 'false', confidence: 0.75, confidenceLevel: 'fairly' }, timeZone: 'UTC' })
    if (result.status !== 'ok') throw new Error(result.status)
    state = result.state
  }
  const data = await reader.loadReader(w.user.id, w.topic.id)
  assert.ok(data)
  assert.equal(data.files[0].passages.length, 3)
  assert.equal(data.focusCount, 2)
  assert.equal(await focus.countFocusPassages(w.user.id, w.topic.id), data.focusCount)
})

// ---------------------------------------------------------------------------------- v3.1: the second turn and the restatement

type CheckAsk = NonNullable<Parameters<typeof import('./reader-server').answerReaderCheck>[3]>
const checkAnswer = (overrides: Partial<Awaited<ReturnType<CheckAsk>>> = {}): CheckAsk => async () => ({
  verdict: 'partly',
  reply: 'You have the same-bucket half.',
  follow_up_question: 'What does the table do with the second key?',
  from_fallback: false,
  ...overrides,
})
const explained = (extra: Record<string, unknown> = {}) => async () => ({ reply: 'It describes what happens to two keys in one bucket.', check_question: 'Which list holds them?', ...extra })

async function firstQuestion(w: Awaited<ReturnType<typeof world>>, ask: NonNullable<Parameters<typeof server.explainPassage>[1]> = explained()) {
  const result = await server.explainPassage({ userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, take: 'it says keys can share a bucket', cantParse: false, timeZone: 'UTC' }, ask)
  assert.equal(result.status, 'ok')
  return (result as Extract<typeof result, { status: 'ok' }>).note
}
const tutorRow = (w: Awaited<ReturnType<typeof world>>) =>
  prisma.tutorState.findUnique({ where: { userId_scope_scopeKey: { userId: w.user.id, scope: 'reader', scopeKey: `${w.topic.id}:${w.chunks[2].id}` } } })

test('the passage rung comes from the reader tutor state, not a count of notes', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-state')
  const asked: ReaderTutorRequest[] = []
  const ask = async (request: ReaderTutorRequest) => (asked.push(request), { reply: 'r', check_question: 'q?' })
  const base = { userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, timeZone: 'UTC' }
  await server.explainPassage({ ...base, take: 'first take here', cantParse: false }, ask)
  // A note on the passage that the state does not know of changes nothing: the state is the count.
  await prisma.marginNote.create({ data: { userId: w.user.id, topicId: w.topic.id, materialId: w.material.id, chunkId: w.chunks[2].id, kind: 'question', text: 'old', reply: { reply: 'x', checkQuestion: 'y?' } } })
  await server.explainPassage({ ...base, take: 'second take here', cantParse: false }, ask)
  await server.explainPassage({ ...base, take: 'third take here', cantParse: false }, ask)
  assert.deepEqual(asked.map((request) => request.rung), [1, 2, 3])
  const row = await tutorRow(w)
  assert.equal(row?.attempts, 3)
  assert.equal(row?.cantParseTurns, 0)
})

test('check answer gets a second turn at level 2', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-check')
  const question = await firstQuestion(w)
  const seen: unknown[] = []
  const ask: CheckAsk = async (request) => (seen.push(request), checkAnswer()(request))
  const result = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'The list on the bucket', timeZone: 'UTC' }, ask)
  assert.equal(result.status, 'ok')
  const request = seen[0] as Record<string, unknown>
  assert.equal(request.turn, 'check')
  assert.equal(request.check_question, 'Which list holds them?')
  assert.equal(request.student_answer, 'The list on the bucket')
  assert.equal(request.dont_know, false)
  assert.equal(request.student_take, 'it says keys can share a bucket')
  assert.deepEqual((request.claims as { text: string }[]).map((claim) => claim.text), ['Collision claim.'])

  // Stored in the margin as an answer, linked to the question it answers; the verdict is stored beside the reply, not in its text.
  const answer = await prisma.marginNote.findFirstOrThrow({ where: { userId: w.user.id, kind: 'answer' } })
  assert.equal(answer.text, 'The list on the bucket')
  assert.equal(answer.chunkId, w.chunks[2].id)
  assert.deepEqual(answer.reply, { reply: 'You have the same-bucket half.', checkQuestion: 'What does the table do with the second key?', verdict: 'partly', parentNoteId: question.id })
  assert.equal(result.status === 'ok' && result.verdict, 'partly')

  // Level 2, source reader, the verdict as the display score (1, 0.5 or 0), no memory change.
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'reader', itemKey: { contains: ':answer:' } } })
  assert.equal(events.length, 1)
  assert.deepEqual([events[0].assistance, events[0].score, events[0].conceptId, events[0].gradedBy], [2, 0.5, w.concepts[1].id, 'model'])
  assert.equal(events[0].confidence, null)
  const memory = await prisma.conceptMemory.findMany({ where: { userId: w.user.id } })
  assert.ok(memory.every((m) => m.nUnassisted === 0))
  // Each tutor reply is one on the passage's day: the explanation and this one.
  assert.equal((await tutorRow(w))?.attempts, 1)
})

test('a right answer scores 1 and a wrong one 0, and an answer is taken once', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-verdicts')
  const question = await firstQuestion(w)
  const right = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'The chained list', timeZone: 'UTC' }, checkAnswer({ verdict: 'right', follow_up_question: '' }))
  assert.equal(right.status, 'ok')
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, itemKey: { contains: ':answer:' } } })
  assert.deepEqual(events.map((event) => event.score), [1])
  // A right answer ends the thread: no follow-up, so there is nothing more to answer, and the same question is not answered twice.
  const again = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'Another try', timeZone: 'UTC' }, checkAnswer())
  assert.equal(again.status, 'answered')
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id, kind: 'answer' } }), 1)
  // The follow-up of a not-yet reply can itself be answered.
  const w2 = await world('rd-followup')
  const q2 = await firstQuestion(w2)
  const first = await server.answerReaderCheck(w2.user.id, w2.topic.id, { noteId: q2.id, answer: 'No idea at all really', timeZone: 'UTC' }, checkAnswer({ verdict: 'not_yet' }))
  assert.equal(first.status, 'ok')
  const followUp = first.status === 'ok' ? first.note : null
  assert.equal(followUp?.reply?.checkQuestion, 'What does the table do with the second key?')
  const second = await server.answerReaderCheck(w2.user.id, w2.topic.id, { noteId: followUp!.id, answer: 'It chains it', timeZone: 'UTC' }, checkAnswer({ verdict: 'right', follow_up_question: '' }))
  assert.equal(second.status, 'ok')
  const chained = await prisma.marginNote.findFirstOrThrow({ where: { userId: w2.user.id, kind: 'answer', text: 'It chains it' } })
  assert.equal((chained.reply as { parentNoteId: string }).parentNoteId, followUp!.id)
})

test('I do not know on a check is level 2, score 0, no confidence, and the verdict is not yet', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-check-idk')
  const question = await firstQuestion(w)
  const seen: Record<string, unknown>[] = []
  const ask: CheckAsk = async (request) => (seen.push(request as unknown as Record<string, unknown>), checkAnswer({ verdict: 'not_yet' })(request))
  const result = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, dontKnow: true, timeZone: 'UTC' }, ask)
  assert.equal(result.status, 'ok')
  assert.equal(seen[0].dont_know, true)
  assert.equal(seen[0].student_answer, "I don't know")
  const event = await prisma.evidenceEvent.findFirstOrThrow({ where: { userId: w.user.id, itemKey: { contains: ':answer:' } } })
  assert.deepEqual([event.assistance, event.score, event.confidence], [2, 0, null])
  assert.deepEqual([(event.metadata as Record<string, unknown>).idk, (event.metadata as Record<string, unknown>).missKind], [true, 'cue_miss'])
  const note = await prisma.marginNote.findFirstOrThrow({ where: { userId: w.user.id, kind: 'answer' } })
  assert.equal(note.text, "I don't know")
  // A typed "idk" is the same thing, whatever the button said.
  const w2 = await world('rd-check-typed-idk')
  const q2 = await firstQuestion(w2)
  const typed = await server.answerReaderCheck(w2.user.id, w2.topic.id, { noteId: q2.id, answer: 'idk', timeZone: 'UTC' }, ask)
  assert.equal(typed.status, 'ok')
  assert.equal(seen[1].dont_know, true)
})

test('a verdict that the tutor could not make is shown as a reply and scores nothing', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-check-fallback')
  const question = await firstQuestion(w)
  const result = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'The chained list', timeZone: 'UTC' }, checkAnswer({ verdict: 'not_yet', reply: 'Read the passage again.', from_fallback: true }))
  assert.equal(result.status, 'ok')
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, itemKey: { contains: ':answer:' } } }), 0)
  const note = await prisma.marginNote.findFirstOrThrow({ where: { userId: w.user.id, kind: 'answer' } })
  assert.deepEqual(note.reply, { reply: 'Read the passage again.', checkQuestion: 'What does the table do with the second key?', verdict: null, parentNoteId: question.id })
})

test('a check answer needs its question, and belongs to its owner; a failed tutor or write keeps nothing', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-check-guard')
  const other = await world('rd-check-guard-other')
  const question = await firstQuestion(w)
  const never: CheckAsk = async () => assert.fail('the tutor is not asked')
  assert.equal((await server.answerReaderCheck(other.user.id, w.topic.id, { noteId: question.id, answer: 'x y z w', timeZone: 'UTC' }, never)).status, 'not_found')
  assert.equal((await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: crypto.randomUUID(), answer: 'x y z w', timeZone: 'UTC' }, never)).status, 'not_found')
  // A plain note has no check question; it cannot be answered.
  const plain = await prisma.marginNote.create({ data: { userId: w.user.id, topicId: w.topic.id, materialId: w.material.id, chunkId: w.chunks[2].id, kind: 'note', text: 'mine' } })
  assert.equal((await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: plain.id, answer: 'x y z w', timeZone: 'UTC' }, never)).status, 'not_found')
  // An empty answer is neither an answer nor an "I don't know".
  assert.equal((await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: '   ', timeZone: 'UTC' }, never)).status, 'invalid')
  const down: CheckAsk = async () => {
    throw new Error('tutor down')
  }
  await assert.rejects(server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'a real answer', timeZone: 'UTC' }, down))
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id, kind: 'answer' } }), 0)
  // No evidence, no exchange: a bad time zone fails the write after the note, and the note is taken back.
  await assert.rejects(server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'a real answer', timeZone: 'Not/AZone' }, checkAnswer()))
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id, kind: 'answer' } }), 0)
})

test('two cant-parse give a restatement', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-restate')
  const asked: Record<string, unknown>[] = []
  const ask = async (request: ReaderTutorRequest) => (asked.push(request as unknown as Record<string, unknown>), { reply: 'Put simply, keys can share a bucket.', check_question: 'What can share a bucket?' })
  const base = { userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, take: '', cantParse: true, timeZone: 'UTC' }
  await server.explainPassage(base, ask)
  assert.ok(asked[0].turn === undefined || asked[0].turn === 'explain')
  assert.equal(asked[0].rung, 1)
  const second = await server.explainPassage(base, ask)
  assert.equal(second.status, 'ok')
  assert.equal(asked[1].turn, 'restate')
  assert.equal(asked[1].rung, 4)
  assert.equal(asked[1].cant_parse, true)
  assert.equal((await tutorRow(w))?.cantParseTurns, 2)
  // The restatement is stored like any explanation, with its rung.
  const notes = await prisma.marginNote.findMany({ where: { userId: w.user.id }, orderBy: { createdAt: 'asc' } })
  assert.equal((notes[1].reply as { rung: number }).rung, 4)
  // A typed take is not a "can't parse": the count and the turn stay as they were.
  await server.explainPassage({ ...base, take: 'I think it is about buckets', cantParse: false }, ask)
  assert.ok(asked[2].turn === undefined || asked[2].turn === 'explain')
  assert.equal((await tutorRow(w))?.cantParseTurns, 2)
})

test('restatement records an instruction event', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-restate-event')
  const ask = async () => ({ reply: 'Put simply, keys can share a bucket.', check_question: 'What can share a bucket?' })
  const base = { userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, take: '', cantParse: true, timeZone: 'UTC' }
  await server.explainPassage(base, ask)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'instruction' } }), 0)
  await server.explainPassage(base, ask)
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'instruction' } })
  assert.equal(events.length, 1)
  assert.equal(events[0].itemKey, `instruction:restatement:${w.chunks[2].id}`)
  assert.deepEqual([events[0].assistance, events[0].score, events[0].weight, events[0].conceptId], [3, 0, 0, w.concepts[1].id])
  // The level-3 explanation of every reader reply is there as before.
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'reader', assistance: 3 } }), 2)
})

test('fifth reply in a day is refused', skip, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rd-cap')
  const base = { userId: w.user.id, topicId: w.topic.id, chunkId: w.chunks[2].id, timeZone: 'UTC' }
  const asked: unknown[] = []
  const ask = async (request: ReaderTutorRequest) => (asked.push(request), { reply: 'r', check_question: 'q?' })
  const question = await firstQuestion(w, ask)
  // An answer is a reply too: one explanation, one answer, two more explanations make four.
  assert.equal((await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: question.id, answer: 'an answer here', timeZone: 'UTC' }, checkAnswer())).status, 'ok')
  assert.equal((await server.explainPassage({ ...base, take: 'another take on it', cantParse: false }, ask)).status, 'ok')
  assert.equal((await server.explainPassage({ ...base, take: 'yet another take', cantParse: false }, ask)).status, 'ok')
  const before = asked.length
  const fifth = await server.explainPassage({ ...base, take: 'a fifth take here', cantParse: false }, ask)
  assert.equal(fifth.status, 'limit')
  const answers = await prisma.marginNote.findMany({ where: { userId: w.user.id, kind: 'question' }, orderBy: { createdAt: 'desc' }, take: 1 })
  const sixth = await server.answerReaderCheck(w.user.id, w.topic.id, { noteId: answers[0].id, answer: 'one more answer', timeZone: 'UTC' }, async () => assert.fail('the tutor is not asked'))
  assert.equal(sixth.status, 'limit')
  assert.equal(asked.length, before)
  assert.equal(await prisma.marginNote.count({ where: { userId: w.user.id, kind: { in: ['question', 'answer'] } } }), 4)
  // Another passage has its own four, and yesterday's replies do not count.
  const elsewhere = await server.explainPassage({ ...base, chunkId: w.chunks[0].id, take: 'a take on the first passage', cantParse: false }, ask)
  assert.equal(elsewhere.status, 'ok')
  await prisma.marginNote.updateMany({ where: { userId: w.user.id, chunkId: w.chunks[2].id }, data: { createdAt: new Date(Date.now() - 36 * 3600_000) } })
  assert.equal((await server.explainPassage({ ...base, take: 'back the next day', cantParse: false }, ask)).status, 'ok')
})
