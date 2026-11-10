/**
 * recordEvidence against a real, migrated Postgres (DATABASE_URL). Skipped when no database with
 * the evidence_events table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { ItemAnswerInput } from './evidence-types'

let prisma: typeof import('@/lib/db/prisma').prisma
let mod: typeof import('./evidence')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  mod = await import('./evidence')
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(
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

const DAY = 24 * 60 * 60 * 1000

async function world(kinds: string[] = ['concept', 'concept']) {
  const user = await prisma.user.create({
    data: { email: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` },
  })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const concepts = []
  for (const [i, kind] of kinds.entries()) {
    concepts.push(
      await prisma.concept.create({
        data: { projectId: project.id, topicId: topic.id, name: `C${i}`, summary: 's', kind, orderIndex: i },
      })
    )
  }
  return { user, project, topic, concepts }
}

function answer(w: Awaited<ReturnType<typeof world>>, over: Partial<ItemAnswerInput> = {}): ItemAnswerInput {
  return {
    userId: w.user.id,
    projectId: w.project.id,
    topicId: w.topic.id,
    itemKey: 'quiz:set1:0',
    conceptIds: [w.concepts[0].id],
    source: 'quiz',
    score: 1,
    assistance: 0,
    gradedBy: 'rule',
    sessionKey: `s-${Math.random().toString(36).slice(2)}`,
    ...over,
  }
}

dbTest('records and replays', async () => {
  const w = await world()
  const { topics } = await mod.recordEvidence([answer(w)])

  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 1)
  const memory = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[0].id } },
  })
  assert.ok(memory.card)
  assert.ok(memory.dueAt)
  assert.equal(memory.nUnassisted, 1)
  const schedule = await prisma.reviewSchedule.findUniqueOrThrow({
    where: { userId_topicId: { userId: w.user.id, topicId: w.topic.id } },
  })
  assert.equal(schedule.dueAt.getTime(), memory.dueAt!.getTime())
  assert.equal(topics.length, 1)
  assert.equal(topics[0].topicId, w.topic.id)
  assert.equal(topics[0].dueAt?.getTime(), memory.dueAt!.getTime())
})

dbTest('opposite-order writers on two concepts do not deadlock', async () => {
  const w = await world()
  const [a, b] = w.concepts.map((c) => c.id)
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      mod.recordEvidence([
        answer(w, { conceptIds: i % 2 ? [a, b] : [b, a], itemKey: `quiz:x:${i}`, sessionKey: `x-${i}` }),
      ])
    )
  )
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 12)
})

dbTest('replaceSessionKeys swaps events (regrade)', async () => {
  const w = await world()
  await mod.recordEvidence([answer(w, { score: 0, sessionKey: 'quiz-attempt-1' })])
  await mod.recordEvidence([answer(w, { score: 1, sessionKey: 'quiz-attempt-1' })], {
    replaceSessionKeys: ['quiz-attempt-1'],
  })
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(events.length, 1)
  assert.equal(events[0].score, 1)
  const memory = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: w.concepts[0].id } },
  })
  assert.equal(memory.consecutiveFails, 0)
  assert.equal((memory.card as { reps: number }).reps, 1)
})

dbTest('implicit credit written for encompassed concept', async () => {
  const w = await world()
  const [big, small] = w.concepts
  await prisma.conceptEdge.create({
    data: {
      projectId: w.project.id,
      sourceId: big.id,
      targetId: small.id,
      type: 'encompasses',
      weight: 1,
      confidence: 1,
      status: 'confirmed',
    },
  })
  const start = new Date(Date.now() - 20 * DAY)
  await mod.recordEvidence([answer(w, { conceptIds: [small.id], itemKey: 'quiz:s:0', sessionKey: 's0', at: start })])
  const before = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: small.id } },
  })

  await mod.recordEvidence([
    answer(w, { conceptIds: [big.id], itemKey: 'quiz:b:0', sessionKey: 'b0', at: new Date(start.getTime() + 10 * DAY) }),
  ])
  const implicit = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source: 'implicit' } })
  assert.equal(implicit.length, 1)
  assert.equal(implicit[0].conceptId, small.id)
  const meta = implicit[0].metadata as Record<string, unknown>
  assert.equal(meta.direction, 'credit')
  assert.equal(meta.pathWeight, 1)
  assert.equal(typeof meta.edgeId, 'string')

  const after = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: small.id } },
  })
  assert.ok(after.stability! > before.stability!)
  // Implicit evidence never counts as the student's own answer.
  assert.equal(after.nUnassisted, 1)
})

dbTest('a transaction that loses a deadlock runs again from the start', async () => {
  const w = await world()
  await mod.recordEvidence([answer(w)])
  let attempts = 0
  await mod.rebuildConcepts(w.user.id, [w.concepts[0].id], 'UTC', async (tx) => {
    attempts += 1
    await tx.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
    if (attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } })
  })
  assert.equal(attempts, 2)
  assert.ok((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt)
})
