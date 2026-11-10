/**
 * The explainer's gate, its gap explanations and its check blocks against a real, migrated Postgres (DATABASE_URL).
 * Skipped when no database with the recall_attempts table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let explainer: typeof import('./explainer-server')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  explainer = await import('./explainer-server')
  available = await prisma.$queryRaw`SELECT 1 FROM recall_attempts LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

/** Two concepts with a claim each; `claims: false` makes a topic with nothing to recall. */
async function world(label: string, options: { claims?: boolean; backfilled?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true, ...(options.backfilled === false ? {} : { evidenceBackfilledAt: new Date() }) } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const concepts = []
  for (const [orderIndex, name] of ['Collision', 'Load factor'].entries()) {
    const concept = await prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [orderIndex] } })
    const claim =
      options.claims === false
        ? null
        : await prisma.conceptClaim.create({ data: { conceptId: concept.id, text: `${name} claim`, quote: `${name} quote`, materialId: material.id, orderIndex: 0, pageStart: 4 + orderIndex } })
    concepts.push({ ...concept, claim })
  }
  return { user, project, topic, concepts }
}

type World = Awaited<ReturnType<typeof world>>

const progress = (w: World, data: Record<string, unknown>) =>
  prisma.topicProgress.upsert({
    where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } },
    create: { topicId: w.topic.id, userId: w.user.id, ...data },
    update: data,
  })

const attemptWith = (w: World, verdicts: string[], extra: Record<string, unknown> = {}) =>
  prisma.recallAttempt.create({
    data: {
      userId: w.user.id,
      topicId: w.topic.id,
      kind: 'recall',
      promptText: 'Explain.',
      objectiveIndex: 0,
      answerText: 'my answer',
      mode: 'text',
      result: { status: 'graded', claims: w.concepts.map((c, i) => ({ claim_id: c.claim?.id, concept_id: c.id, verdict: verdicts[i] ?? 'covered' })) },
      ...extra,
    },
  })

test('asked unlock records reason asked, and the unlock needs the topic read', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-locked')
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: false, why: null, canUnlock: false })
  assert.deepEqual(await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id }), { status: 'read_first' })
  const row = await prisma.topicProgress.findUnique({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(row?.explainerUnlockedAt ?? null, null)

  // Warming up is not reading.
  await progress(w, { warmupAt: new Date() })
  assert.equal((await explainer.explainerAccess(w.user.id, w.topic.id))?.canUnlock, false)

  await progress(w, { readAt: new Date() })
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: false, why: null, canUnlock: true })
  assert.deepEqual(await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id }), { status: 'ok' })
  const unlocked = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(unlocked.explainerUnlockReason, 'asked')
  assert.ok(unlocked.explainerUnlockedAt)
  assert.equal((await explainer.explainerAccess(w.user.id, w.topic.id))?.open, true)

  // Asking again keeps the first unlock.
  await explainer.unlockExplainer({ userId: w.user.id, topicId: w.topic.id })
  const again = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(again.explainerUnlockedAt?.getTime(), unlocked.explainerUnlockedAt?.getTime())
})

test('a recall opens the explainer, and nobody else can see the topic', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-recalled')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  assert.deepEqual(await explainer.explainerAccess(w.user.id, w.topic.id), { open: true, why: 'recalled', canUnlock: true })
  const other = await world('ex-other')
  assert.equal(await explainer.explainerAccess(other.user.id, w.topic.id), null)
  assert.deepEqual(await explainer.unlockExplainer({ userId: other.user.id, topicId: w.topic.id }), { status: 'not_found' })
})

test('the gap explanations shown are level-3 help, once per attempt; the full explainer writes nothing', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('ex-shown')
  await progress(w, { readAt: new Date(), recallAt: new Date() })
  const claim = w.concepts[1].claim
  const attempt = await attemptWith(w, ['covered', 'missing'], {
    explainer: {
      status: 'ready',
      gaps: [{ claim_id: claim?.id, concept_id: w.concepts[1].id, concept_name: 'Load factor', explanation: 'It is entries over buckets.', check: { question: 'What is it?', answer: 'Entries over buckets.' }, source: { filename: 'notes.pdf', page: 5 } }],
      skipped: [],
    },
  })
  // Opening the explainer (the visit) writes no evidence.
  await explainer.markExplainerViewed(w.user.id, w.topic.id)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 0)

  assert.equal(await explainer.recordGapsShown({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' }), 1)
  const rows = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].conceptId, w.concepts[1].id)
  assert.equal(rows[0].assistance, 3)
  assert.equal(rows[0].source, 'example')
  assert.equal(rows[0].score, 0)
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[1].id } } })
  assert.ok(memory.lastAssistedAt)
  assert.equal(memory.nUnassisted, 0)

  // Showing them again, or again after a reload, is not a second record.
  assert.equal(await explainer.recordGapsShown({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' }), 0)
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 1)
  const stored = (await prisma.recallAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).explainer as Record<string, unknown>
  assert.ok(stored.gapsShownAt)
  assert.ok(stored.viewedAt)
})
