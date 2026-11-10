/**
 * Recall and teach-back against a real, migrated Postgres (DATABASE_URL). The grader is a fake that answers by
 * the verdicts a test hands it. Skipped when no database with the recall_attempts table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { RecallClaimVerdict, RecallGradeAnswer, RecallGradeRequest } from '@/lib/ai-service/recall'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let recall: typeof import('./recall-server')
let available = false

const ZONE = 'UTC'

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  recall = await import('./recall-server')
  available = await prisma.$queryRaw`SELECT 1 FROM recall_attempts LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

const ANSWER = 'A hash table sends each key to a bucket, and two keys that land in the same bucket collide, so the bucket keeps a list.'

/** Objective 0: Hash function (1 claim) and Collision (2 claims). Objective 1: Load factor (1 claim). */
async function world(label: string, options: { claims?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const specs = [
    { name: 'Hash function', objectives: [0], claims: ['A hash function maps a key to a bucket index.'] },
    { name: 'Collision', objectives: [0], claims: ['A collision is two keys in the same bucket.', 'Chaining keeps a list per bucket.'] },
    { name: 'Load factor', objectives: [1], claims: ['The load factor is entries divided by buckets.'] },
  ]
  const concepts = []
  for (const [orderIndex, spec] of specs.entries()) {
    const concept = await prisma.concept.create({
      data: { projectId: project.id, topicId: topic.id, name: spec.name, summary: `${spec.name}.`, kind: 'concept', orderIndex, objectiveIndexes: spec.objectives },
    })
    const claims = []
    if (options.claims !== false) {
      for (const [n, claimText] of spec.claims.entries()) {
        claims.push(
          await prisma.conceptClaim.create({
            data: { conceptId: concept.id, text: claimText, quote: `Quote for ${claimText}`, materialId: material.id, orderIndex: n, pageStart: 4 + orderIndex },
          })
        )
      }
    }
    concepts.push({ ...concept, claims })
  }
  await prisma.topicContent.create({
    data: {
      topicId: topic.id,
      contentType: 'concept_prompts',
      contentData: {
        focus_questions: [],
        recall_prompts: [
          { objective_index: 0, prompt: 'Explain how a hash table handles keys that share a bucket.' },
          { objective_index: 1, prompt: 'Explain what the load factor tells you.' },
        ],
      },
    },
  })
  return { user, project, topic, concepts }
}

type World = Awaited<ReturnType<typeof world>>

/** A grader that answers with verdicts by claim text (a prefix), and records what it was asked. */
function fakeGrader(w: World, rules: Record<string, Partial<RecallClaimVerdict> & { verdict: RecallClaimVerdict['verdict'] }>, extra: Partial<RecallGradeAnswer> = {}) {
  const asked: RecallGradeRequest[] = []
  const grade = async (request: RecallGradeRequest): Promise<RecallGradeAnswer> => {
    asked.push(request)
    return {
      status: 'graded',
      confidence: 0.9,
      verdicts: request.claims.map((claim) => {
        const rule = Object.entries(rules).find(([prefix]) => claim.text.startsWith(prefix))?.[1] ?? { verdict: 'missing' as const }
        return { claim_id: claim.id, student_quote: null, ...rule }
      }),
      ...extra,
    }
  }
  return { grade, asked }
}

const submit = (w: World, grade: Parameters<typeof recall.submitRecall>[1], over: Partial<Parameters<typeof recall.submitRecall>[0]> = {}) =>
  recall.submitRecall({ userId: w.user.id, topicId: w.topic.id, kind: 'recall', objectiveIndex: 0, answer: ANSWER, abandoned: false, inputMode: 'text', timeZone: ZONE, ...over }, grade)

const events = (w: World, source: string) => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source }, orderBy: [{ conceptId: 'asc' }, { createdAt: 'asc' }] })

test('a graded recall stores the attempt, writes level-0 model evidence per concept and sets recallAt', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-graded')
  const { grade, asked } = fakeGrader(w, {
    'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' },
    'A collision': { verdict: 'covered', student_quote: 'land in the same bucket collide' },
    'Chaining': { verdict: 'missing', pointer: 'Look again at p. 5: What does a bucket hold?' },
  })
  const result = await submit(w, grade)
  assert.equal(result.status, 'graded')
  assert.equal(asked.length, 1)

  const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.equal(attempt.kind, 'recall')
  assert.equal(attempt.objectiveIndex, 0)
  assert.equal(attempt.answerText, ANSWER)
  assert.equal(attempt.mode, 'text')
  assert.equal(attempt.promptText, 'Explain how a hash table handles keys that share a bucket.')

  const rows = await events(w, 'recall')
  assert.equal(rows.length, 2)
  const byConcept = new Map(rows.map((row) => [row.conceptId, row]))
  const hash = byConcept.get(w.concepts[0].id)
  const collision = byConcept.get(w.concepts[1].id)
  assert.equal(hash?.score, 1)
  assert.equal(collision?.score, 0.5) // one claim covered, one missing
  for (const row of rows) {
    assert.equal(row.assistance, 0)
    assert.equal(row.gradedBy, 'model')
    assert.equal(row.weight, 0.7)
    assert.equal(row.itemKey, `recall:${w.topic.id}:0`)
    assert.equal(row.sessionKey, `recall:${attempt.id}`)
  }
  assert.equal((collision?.metadata as Record<string, unknown>).missKind, 'cue_miss')
  assert.equal((hash?.metadata as Record<string, unknown>).mode, 'recall')

  const progress = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.ok(progress.recallAt)
})

test('claims limited to objective concepts', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-limited')
  const { grade, asked } = fakeGrader(w, {})
  await submit(w, grade, { objectiveIndex: 1 })
  assert.deepEqual(asked[0].claims.map((c) => c.concept_name), ['Load factor'])
  assert.equal(asked[0].prompt, 'Explain what the load factor tells you.')
  // The whole topic sends every concept's claims.
  await submit(w, grade, { objectiveIndex: null })
  assert.equal(asked[1].claims.length, 4)
  assert.equal(asked[1].prompt, recall.WHOLE_TOPIC_PROMPT)
  assert.ok((await prisma.recallAttempt.findMany({ where: { userId: w.user.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.objectiveIndex).every((v, i) => v === (i === 0 ? 1 : null)))
  assert.equal((await events(w, 'recall')).some((row) => row.itemKey === `recall:${w.topic.id}:all`), true)
})

test('incorrect sets misconception on the concept', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-misconception')
  const { grade } = fakeGrader(w, {
    'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' },
    'A collision': { verdict: 'incorrect', student_quote: 'land in the same bucket collide', misconception: 'A second key replaces the first', kind: 'misconception' },
    'Chaining': { verdict: 'missing' },
  })
  const result = await submit(w, grade)
  assert.equal(result.status, 'graded')
  const collision = (await events(w, 'recall')).find((row) => row.conceptId === w.concepts[1].id)
  const metadata = collision?.metadata as Record<string, unknown>
  assert.equal(metadata.missKind, 'misconception')
  assert.equal(metadata.misconception, 'A second key replaces the first')
  // The learner model reads it: the concept now carries the misconception.
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: w.concepts[1].id } })
  assert.equal(memory.misconception, 'A second key replaces the first')
  if (result.status === 'graded') {
    // The student sees what is wrong with the source's words, and their own quote.
    assert.equal(result.feedback.wrong.length, 1)
    assert.equal(result.feedback.wrong[0].studentQuote, 'land in the same bucket collide')
    assert.match(result.feedback.wrong[0].sourceQuote, /^Quote for A collision/)
    assert.equal(result.feedback.wrong[0].page, 5)
  }
})

test('a level-0 recall of 0.75 or more opens the judgment gate for the concept', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-gate')
  const { grade } = fakeGrader(w, {
    'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' },
    'A collision': { verdict: 'covered', student_quote: 'collide' },
    'Chaining': { verdict: 'partial', student_quote: 'keeps a list' },
  })
  await submit(w, grade)
  const memory = async (conceptId: string) => (await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId } })).derived as Record<string, unknown>
  assert.equal((await memory(w.concepts[0].id)).explainedWell, true)
  assert.equal((await memory(w.concepts[1].id)).explainedWell, true) // (1 + 0.5) / 2 = 0.75
})

test('opening the reader during recall makes the answer level 2: no explained-well, still recalled', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-abandoned')
  const { grade } = fakeGrader(w, {
    'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' },
    'A collision': { verdict: 'covered', student_quote: 'collide' },
    'Chaining': { verdict: 'covered', student_quote: 'keeps a list' },
  })
  const result = await submit(w, grade, { abandoned: true })
  assert.equal(result.status, 'graded')
  const rows = await events(w, 'recall')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.assistance === 2 && (row.metadata as Record<string, unknown>).abandoned === true))
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: w.concepts[0].id } })
  assert.equal((memory.derived as Record<string, unknown>).explainedWell, false)
  assert.equal(memory.nUnassisted, 0)
  // Not a level-0 recall: it does not mark the topic recalled (and so does not open the explainer).
  assert.equal(await prisma.topicProgress.count({ where: { userId: w.user.id, recallAt: { not: null } } }), 0)
  if (result.status === 'graded') assert.equal(result.feedback.abandoned, true)
  // The next card answered with the book closed is level 0 and sets recallAt.
  await submit(w, grade, { objectiveIndex: 1 })
  assert.ok((await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })).recallAt)
})

test('an unclear answer stores nothing and sets nothing', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-ungraded')
  const grade = async (): Promise<RecallGradeAnswer> => ({ status: 'ungraded', verdicts: [], clarifying_question: 'Which part do you mean?', confidence: 0.4 })
  const result = await submit(w, grade, { answer: 'uh the thing with the stuff I think' })
  assert.deepEqual(result, { status: 'ungraded', clarifyingQuestion: 'Which part do you mean?' })
  assert.equal(await prisma.recallAttempt.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.topicProgress.count({ where: { userId: w.user.id } }), 0)
  // No question from the grader: a plain one.
  const mute = await submit(w, async () => ({ status: 'ungraded', verdicts: [], confidence: 0.2 }))
  assert.equal(mute.status === 'ungraded' && mute.clarifyingQuestion.endsWith('?'), true)
})

test('when the AI is unavailable nothing is stored and the error reaches the caller', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const { TutorUnavailableError } = await import('@/lib/ai-service/tutor')
  const w = await world('rc-503')
  await assert.rejects(() => submit(w, async () => { throw new TutorUnavailableError('LLM_UNAVAILABLE', 503) }), TutorUnavailableError)
  assert.equal(await prisma.recallAttempt.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)
})

test('an evidence failure leaves no attempt behind', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const { failEvidenceWrites } = await import('./evidence-test-support')
  const w = await world('rc-evidence-fail')
  const restore = await failEvidenceWrites(prisma, w.user.id)
  try {
    await assert.rejects(() => submit(w, fakeGrader(w, { 'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' } }).grade))
  } finally {
    await restore()
  }
  assert.equal(await prisma.recallAttempt.count({ where: { userId: w.user.id } }), 0)
  assert.equal(await prisma.topicProgress.count({ where: { userId: w.user.id } }), 0)
})

test('teach-back of one concept grades that concept alone, writes teach_back evidence and leaves recallAt', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-teach')
  const { grade, asked } = fakeGrader(w, { 'A collision': { verdict: 'covered', student_quote: 'collide' }, 'Chaining': { verdict: 'covered', student_quote: 'keeps a list' } })
  const result = await submit(w, grade, { kind: 'teach_back', objectiveIndex: null, conceptId: w.concepts[1].id })
  assert.equal(result.status, 'graded')
  assert.deepEqual(asked[0].claims.map((c) => c.concept_name), ['Collision', 'Collision'])
  assert.equal(asked[0].prompt, recall.conceptTeachBackPrompt('Collision'))
  const rows = await events(w, 'teach_back')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, 1)
  assert.equal(rows[0].assistance, 0)
  assert.equal(rows[0].itemKey, `teach_back:${w.topic.id}:${w.concepts[1].id}`)
  const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.equal(attempt.kind, 'teach_back')
  assert.equal((attempt.result as Record<string, unknown>).conceptId, w.concepts[1].id)
  assert.equal(await prisma.topicProgress.count({ where: { userId: w.user.id } }), 0)
  // The card remembers its newest attempt.
  const state = await recall.loadRecallState(w.user.id, w.topic.id, { mode: 'teach_back', conceptId: w.concepts[1].id })
  assert.equal(state?.cards.length, 1)
  assert.equal(state?.cards[0].latest?.attemptId, attempt.id)
  // A concept of another topic is not a target.
  assert.equal((await submit(w, grade, { kind: 'teach_back', objectiveIndex: null, conceptId: 'nope' })).status, 'not_ready')
})

test('feedback keeps what the student missed out of sight until they ask', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-reveal')
  const { grade } = fakeGrader(w, {
    'A hash function': { verdict: 'covered', student_quote: 'sends each key to a bucket' },
    'A collision': { verdict: 'covered', student_quote: 'collide' },
    'Chaining': { verdict: 'missing', pointer: 'Look again at p. 5: What does a bucket hold?' },
  })
  const result = await submit(w, grade)
  assert.equal(result.status, 'graded')
  if (result.status !== 'graded') return
  const shown = JSON.stringify(result.feedback)
  assert.equal(shown.includes('Chaining keeps a list per bucket.'), false)
  assert.equal(shown.includes('Quote for Chaining'), false)
  assert.deepEqual(result.feedback.missed.map((m) => m.pointer), ['Look again at p. 5: What does a bucket hold?'])
  assert.deepEqual(result.feedback.got.map((g) => g.quote), ['sends each key to a bucket', 'collide'])
  assert.equal(result.feedback.revealed, null)

  const revealed = await recall.revealMissed({ userId: w.user.id, topicId: w.topic.id, attemptId: result.feedback.attemptId, timeZone: ZONE })
  assert.equal(revealed.status, 'ok')
  if (revealed.status === 'ok') {
    assert.deepEqual(revealed.revealed.map((r) => r.text), ['Chaining keeps a list per bucket.'])
    assert.equal(revealed.revealed[0].page, 5)
  }
  // Level 3 on the concept with the missed claim only.
  const level3 = (await events(w, 'recall')).filter((row) => row.assistance === 3)
  assert.deepEqual(level3.map((row) => row.conceptId), [w.concepts[1].id])
  assert.equal(level3[0].sessionKey, `recall-reveal:${result.feedback.attemptId}`)
  // Asking again changes nothing, and the attempt remembers it was revealed.
  await recall.revealMissed({ userId: w.user.id, topicId: w.topic.id, attemptId: result.feedback.attemptId, timeZone: ZONE })
  assert.equal((await events(w, 'recall')).filter((row) => row.assistance === 3).length, 1)
  const state = await recall.loadRecallState(w.user.id, w.topic.id)
  assert.equal(state?.cards[0].latest?.revealed?.length, 1)
  // Another student cannot reveal it.
  const other = await world('rc-reveal-other')
  assert.deepEqual(await recall.revealMissed({ userId: other.user.id, topicId: w.topic.id, attemptId: result.feedback.attemptId, timeZone: ZONE }), { status: 'not_found' })
})

test('the recall step has cards for each objective and the whole topic, and none without claims', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-cards')
  const state = await recall.loadRecallState(w.user.id, w.topic.id)
  assert.deepEqual(state?.cards.map((c) => c.key), ['o0', 'o1', 'all'])
  assert.equal(state?.cards[0].prompt, 'Explain how a hash table handles keys that share a bucket.')
  assert.ok(state?.cards.every((c) => c.latest === null))

  const bare = await world('rc-bare', { claims: false })
  assert.deepEqual((await recall.loadRecallState(bare.user.id, bare.topic.id))?.cards, [])
  assert.equal((await submit(bare, fakeGrader(bare, {}).grade)).status, 'not_ready')
  assert.equal(await recall.loadRecallState(w.user.id, bare.topic.id), null)
  assert.deepEqual(await submit(w, fakeGrader(w, {}).grade, { answer: '   ' }), { status: 'invalid', message: 'Write what you remember first.' })
  assert.equal((await submit({ ...w, user: bare.user }, fakeGrader(w, {}).grade)).status, 'not_found')
})

const good = { 'A hash function': { verdict: 'covered' as const, student_quote: 'sends each key to a bucket' }, 'A collision': { verdict: 'covered' as const, student_quote: 'collide' }, 'Chaining': { verdict: 'covered' as const, student_quote: 'keeps a list' } }
const bad = { 'A hash function': { verdict: 'missing' as const }, 'A collision': { verdict: 'missing' as const }, 'Chaining': { verdict: 'missing' as const } }
const meta = (row: { metadata: unknown }) => row.metadata as Record<string, unknown>

test('a second try the same day after feedback is level 2 when it succeeds, and a level-1 failure when it does not', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-same-day')
  await submit(w, fakeGrader(w, { ...good, 'Chaining': { verdict: 'missing' } }).grade) // first: level 0
  const again = await submit(w, fakeGrader(w, good).grade)
  assert.equal(again.status === 'graded' && again.feedback.repeat, 'seen')
  const second = (await events(w, 'recall')).filter((row) => meta(row).repeat === 'seen')
  assert.equal(second.length, 2)
  assert.ok(second.every((row) => row.assistance === 2 && row.score > 0))
  // A third try that fails is the failure only, score 0.
  await submit(w, fakeGrader(w, bad).grade)
  const third = (await events(w, 'recall')).filter((row) => row.assistance === 1)
  assert.equal(third.length, 2)
  assert.ok(third.every((row) => row.score === 0))
  // Another card is a first attempt of its own.
  await submit(w, fakeGrader(w, good).grade, { objectiveIndex: 1 })
  assert.ok((await events(w, 'recall')).some((row) => row.itemKey.endsWith(':1') && row.assistance === 0))
})

test('feedback on one card makes an answer to another card on the same ideas a second try, whatever the card', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-other-card')
  await submit(w, fakeGrader(w, { ...good, 'Chaining': { verdict: 'missing' } }).grade) // objective 0: Hash function and Collision
  // An idea the feedback never named is a first look.
  const other = await submit(w, fakeGrader(w, good).grade, { objectiveIndex: 1 })
  assert.equal(other.status === 'graded' && other.feedback.repeat, null)
  // The whole-topic card covers ideas already shown, so it is a second try, not a fresh retrieval.
  const whole = await submit(w, fakeGrader(w, good).grade, { objectiveIndex: null })
  assert.equal(whole.status === 'graded' && whole.feedback.repeat, 'seen')
  // So is a teach-back of one of them, even though it is another kind of card.
  const teach = await submit(w, fakeGrader(w, good).grade, { kind: 'teach_back', conceptId: w.concepts[1].id, objectiveIndex: undefined })
  assert.equal(teach.status === 'graded' && teach.feedback.repeat, 'seen')
})

test('a re-answer after "Show me what I missed" is level 3', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-after-reveal')
  const first = await submit(w, fakeGrader(w, { ...good, 'Chaining': { verdict: 'missing' } }).grade)
  assert.equal(first.status, 'graded')
  if (first.status !== 'graded') return
  await recall.revealMissed({ userId: w.user.id, topicId: w.topic.id, attemptId: first.feedback.attemptId, timeZone: ZONE })
  const again = await submit(w, fakeGrader(w, good).grade)
  assert.equal(again.status === 'graded' && again.feedback.repeat, 'revealed')
  const rows = (await events(w, 'recall')).filter((row) => meta(row).repeat === 'revealed')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.assistance === 3 && row.score === 0))
})

test('a re-answer on a later local day is a fresh level-0 retrieval', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-next-day')
  await submit(w, fakeGrader(w, good).grade)
  await prisma.recallAttempt.updateMany({ where: { userId: w.user.id }, data: { createdAt: new Date(Date.now() - 30 * 3_600_000) } })
  const next = await submit(w, fakeGrader(w, good).grade)
  assert.equal(next.status === 'graded' && next.feedback.repeat, null)
  const id = next.status === 'graded' ? next.feedback.attemptId : ''
  const fresh = (await events(w, 'recall')).filter((row) => meta(row).attemptId === id)
  assert.equal(fresh.length, 2)
  assert.ok(fresh.every((row) => row.assistance === 0))
})

test('explainedWell comes only from level-0 attempts', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-explained-assisted')
  await submit(w, fakeGrader(w, bad).grade) // first try fails at level 0
  await submit(w, fakeGrader(w, good).grade) // same-day retry succeeds, assisted
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: w.concepts[0].id } })
  assert.equal((memory.derived as Record<string, unknown>).explainedWell, false)
})

test('the card and the gaps read the newest attempt of every card, however many attempts there are', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-many')
  await submit(w, fakeGrader(w, bad).grade) // objective 0, left with gaps
  const old = new Date(Date.now() - 5 * 86_400_000)
  await prisma.recallAttempt.updateMany({ where: { userId: w.user.id }, data: { createdAt: old } })
  await prisma.recallAttempt.createMany({
    data: Array.from({ length: 70 }, (_, i) => ({ userId: w.user.id, topicId: w.topic.id, kind: 'recall', promptText: 'p', answerText: 'x', mode: 'text', objectiveIndex: 1, result: { claims: [] }, createdAt: new Date(Date.now() - (80 - i) * 60_000) })),
  })
  await prisma.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  const server = await import('./next-activity-server')
  const state = await server.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id })
  assert.deepEqual([...state.recallGaps].sort(), [w.concepts[0].id, w.concepts[1].id].sort())
  const cards = await recall.loadRecallState(w.user.id, w.topic.id)
  assert.ok(cards?.cards.find((c) => c.key === 'o0')?.latest)
})

test('two answers to one card sent together: only one is a first try', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-concurrent')
  // Both graders wait until both requests are at the grader, so both reach the repeat check together.
  let waiting = 0
  let release: () => void = () => {}
  const bothHere = new Promise<void>((resolve) => (release = resolve))
  const inner = fakeGrader(w, good).grade
  const grade = async (request: RecallGradeRequest) => {
    if (++waiting === 2) release()
    await bothHere
    return inner(request)
  }
  const [a, b] = await Promise.all([submit(w, grade), submit(w, grade)])
  assert.ok(a.status === 'graded' && b.status === 'graded')
  const repeats = [a, b].map((r) => (r.status === 'graded' ? r.feedback.repeat ?? null : 'x'))
  assert.deepEqual([...repeats].sort(), [null, 'seen'])
  assert.equal(await prisma.recallAttempt.count({ where: { userId: w.user.id } }), 2)
  // Level-0 evidence from one attempt only: the first try's, one event per concept (Hash function and Collision).
  const levelZero = (await events(w, 'recall')).filter((row) => row.assistance === 0)
  assert.equal(levelZero.length, 2)
})

// ------------------------------------------------------------------------------------------ "I don't remember" (spec 18.3)

test("I don't remember writes level 1 on every card concept", { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-idk-level')
  const { grade, asked } = fakeGrader(w, good)
  const result = await submit(w, grade, { idk: true, answer: '' })
  assert.equal(result.status, 'graded')
  assert.equal(asked.length, 0)
  const rows = await events(w, 'recall')
  // Objective 0 covers Hash function and Collision.
  assert.deepEqual(rows.map((row) => row.conceptId).sort(), [w.concepts[0].id, w.concepts[1].id].sort())
  for (const row of rows) {
    assert.equal(row.assistance, 1)
    assert.equal(row.score, 0)
    assert.equal(row.gradedBy, 'rule')
    assert.equal(row.confidence, null)
    assert.equal(meta(row).idk, true)
    assert.equal(meta(row).missKind, 'cue_miss')
    assert.equal(meta(row).misconception, undefined)
  }
  const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId: w.user.id } })
  const stored = attempt.result as { idk?: boolean; claims: { verdict: string }[] }
  assert.equal(stored.idk, true)
  assert.equal(stored.claims.length, 3)
  assert.ok(stored.claims.every((claim) => claim.verdict === 'missing'))
  if (result.status === 'graded') {
    assert.equal(result.feedback.idk, true)
    assert.equal(result.feedback.help?.pointers.length, 2)
    assert.ok(result.feedback.help?.pointers.every((p) => p.href.includes('view=read&focus=')))
  }
  // It sets recallAt once.
  const first = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.ok(first.recallAt)
  await new Promise((resolve) => setTimeout(resolve, 15))
  await submit(w, fakeGrader(w, good).grade, { idk: true, answer: '', objectiveIndex: 1 })
  const second = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(second.recallAt?.getTime(), first.recallAt?.getTime())
})

test('typed idk is treated as I don\'t remember without a grader call', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-idk-typed')
  const { grade, asked } = fakeGrader(w, good)
  const result = await submit(w, grade, { answer: "I don't know" })
  assert.equal(asked.length, 0)
  assert.equal(result.status === 'graded' && result.feedback.idk, true)
  assert.ok((await events(w, 'recall')).every((row) => row.assistance === 1 && row.score === 0))
  const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId: w.user.id } })
  assert.equal(attempt.answerText, "I don't know")
})

test('idk starts the gap explainer for every claim', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-idk-explainer')
  await submit(w, fakeGrader(w, good).grade, { idk: true, answer: '' })
  const attempt = await prisma.recallAttempt.findFirstOrThrow({ where: { userId: w.user.id } })
  const explainer = await import('./explainer-server')
  assert.deepEqual(explainer.gapClaimIds(attempt.result).sort(), w.concepts.slice(0, 2).flatMap((c) => c.claims.map((claim) => claim.id)).sort())
})

test('a recall with gaps carries the help after a miss, and a clean one does not', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('rc-help')
  const gaps = await submit(w, fakeGrader(w, { ...good, 'Chaining': { verdict: 'missing' } }).grade)
  assert.equal(gaps.status === 'graded' && gaps.feedback.help?.pointers.map((p) => p.conceptId).join(), w.concepts[1].id)
  const state = await recall.loadRecallState(w.user.id, w.topic.id)
  assert.equal(state?.cards[0].latest?.help?.pointers.length, 1)
  const clean = await world('rc-help-clean')
  const done = await submit(clean, fakeGrader(clean, good).grade)
  assert.equal(done.status === 'graded' && done.feedback.help, null)
})
