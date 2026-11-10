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

// ------------------------------------------------------------------------------------------ "I don't remember" (spec 18.3)
