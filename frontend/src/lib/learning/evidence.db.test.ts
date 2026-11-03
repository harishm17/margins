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

dbTest('concurrent writers keep both events', async () => {
  const w = await world()
  const conceptId = w.concepts[0].id
  await Promise.all([
    mod.recordEvidence([answer(w, { itemKey: 'quiz:a:0', sessionKey: 'sess-a' })]),
    mod.recordEvidence([answer(w, { itemKey: 'quiz:b:0', sessionKey: 'sess-b', at: new Date(Date.now() + DAY) })]),
  ])
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 2)

  // Many writers on distinct days: the cached memory must equal a full replay of every event.
  const base = Date.now() + 10 * DAY
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      mod.recordEvidence([
        answer(w, { itemKey: `quiz:c:${i}`, sessionKey: `sess-c${i}`, at: new Date(base + i * DAY) }),
      ])
    )
  )
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id } }), 10)
  const key = { userId_conceptId: { userId: w.user.id, conceptId } }
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: key })
  assert.equal(memory.nUnassisted, 10)
  assert.equal((memory.card as { reps: number }).reps, 10)

  await mod.rebuildConcepts(w.user.id, [conceptId], 'UTC')
  const rebuilt = await prisma.conceptMemory.findUniqueOrThrow({ where: key })
  assert.deepEqual(rebuilt.card, memory.card)
  assert.equal(rebuilt.nUnassisted, memory.nUnassisted)
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

async function encompassing(w: Awaited<ReturnType<typeof world>>) {
  const [big, small] = w.concepts
  await prisma.conceptEdge.create({
    data: { projectId: w.project.id, sourceId: big.id, targetId: small.id, type: 'encompasses', weight: 1, confidence: 1, status: 'confirmed' },
  })
  return { big, small }
}

dbTest('a session saved in several writes credits an encompassed concept once', async () => {
  const w = await world()
  const { big, small } = await encompassing(w)
  const start = new Date(Date.now() - 20 * DAY)
  const base = start.getTime() + 10 * DAY
  await mod.recordEvidence([answer(w, { conceptIds: [small.id], itemKey: 'quiz:s:0', sessionKey: 's0', at: start })])
  // The same session, saved four times (a practice session saves as the student goes).
  for (let i = 0; i < 4; i++) {
    await mod.recordEvidence([answer(w, { conceptIds: [big.id], itemKey: `practice:p:${i}`, sessionKey: 'p0', at: new Date(base + i * 1000) })])
  }
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'implicit' } }), 1)

  // One session gives the same memory whether it was saved four times or once.
  const once = await world()
  const other = await encompassing(once)
  await mod.recordEvidence([answer(once, { conceptIds: [other.small.id], itemKey: 'quiz:s:0', sessionKey: 's0', at: start })])
  await mod.recordEvidence(
    [0, 1, 2, 3].map((i) => answer(once, { conceptIds: [other.big.id], itemKey: `practice:p:${i}`, sessionKey: 'p0', at: new Date(base + i * 1000) }))
  )
  const a = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: small.id } } })
  const b = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: once.user.id, conceptId: other.small.id } } })
  assert.equal(a.stability, b.stability)
  assert.equal(a.dueAt!.getTime(), b.dueAt!.getTime())
})

dbTest('a later save that lowers a session rating takes its earlier credit back', async () => {
  const w = await world()
  const { big, small } = await encompassing(w)
  const start = new Date(Date.now() - 20 * DAY)
  const base = start.getTime() + 10 * DAY
  await mod.recordEvidence([answer(w, { conceptIds: [small.id], itemKey: 'quiz:s:0', sessionKey: 's0', at: start })])
  await mod.recordEvidence([answer(w, { conceptIds: [big.id], itemKey: 'practice:p:0', sessionKey: 'p0', at: new Date(base) })])
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'implicit' } }), 1)
  await mod.recordEvidence([answer(w, { conceptIds: [big.id], itemKey: 'practice:p:1', sessionKey: 'p0', score: 0, at: new Date(base + 1000) })])
  // The session now rates Hard (mean 0.5): no credit stands.
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, source: 'implicit', conceptId: small.id, score: 1 } }), 0)
})

dbTest('topic without concept cards keeps its schedule', async () => {
  const w = await world()
  const dueAt = new Date(Date.now() + 3 * DAY)
  await prisma.reviewSchedule.create({
    data: { userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, mastery: 0.6, dueAt, intervalDays: 3, streak: 2 },
  })
  await mod.recordEvidence([
    answer(w, { source: 'warmup', itemKey: 'warmup:s:0', sessionKey: 'w1', score: 0.5 }),
  ])
  const schedule = await prisma.reviewSchedule.findUniqueOrThrow({
    where: { userId_topicId: { userId: w.user.id, topicId: w.topic.id } },
  })
  assert.equal(schedule.dueAt.getTime(), dueAt.getTime())
  assert.equal(schedule.mastery, 0.6)
  assert.equal(schedule.streak, 2)
  assert.equal(await mod.hasConcepts(w.topic.id), true)
})

dbTest('stored itemKey, gradedBy and metadata reach replay', async () => {
  const w = await world(['judgment'])
  const [c] = w.concepts
  const base = Date.now() - 5 * DAY
  const run = (i: number, day: number, extra: Partial<ItemAnswerInput> = {}) =>
    mod.recordEvidence([
      answer(w, {
        conceptIds: [c.id],
        itemKey: `quiz:set:${i}`,
        sessionKey: `m-${i}`,
        at: new Date(base + day * DAY),
        ...extra,
      }),
    ])
  await run(0, 0)
  await run(1, 1)
  await run(2, 2, {
    gradedBy: 'model',
    metadata: { questionType: 'short_answer', mode: 'recall', maxRung: 2, missKind: 'careless' },
  })
  const memory = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: c.id } },
  })
  const derived = memory.derived as Record<string, unknown>
  // A success on a later local day, on an item not seen before (needs the stored itemKey).
  assert.equal(derived.delayedNewSuccess, true)
  // A model-graded short answer opens the judgment gate (needs gradedBy and metadata).
  assert.equal(derived.explainedWell, true)
  assert.equal(derived.lastMaxRung, 2)
  assert.deepEqual(derived.itemKeysSeen, ['quiz:set:0', 'quiz:set:1', 'quiz:set:2'])
})

dbTest('different concepts in one topic written concurrently, no schedule row yet', async () => {
  const w = await world()
  const [a, b] = w.concepts.map((c) => c.id)
  await Promise.all([
    mod.recordEvidence([answer(w, { conceptIds: [a], itemKey: 'quiz:t:0', sessionKey: 't-a' })]),
    mod.recordEvidence([answer(w, { conceptIds: [b], itemKey: 'quiz:t:1', sessionKey: 't-b', score: 0.8 })]),
  ])
  const key = { userId_topicId: { userId: w.user.id, topicId: w.topic.id } }
  const before = await prisma.reviewSchedule.findUniqueOrThrow({ where: key })
  await mod.rebuildConcepts(w.user.id, [a, b], 'UTC')
  const after = await prisma.reviewSchedule.findUniqueOrThrow({ where: key })
  assert.equal(after.dueAt.getTime(), before.dueAt.getTime())
  assert.equal(after.intervalDays, before.intervalDays)
  assert.ok(Math.abs(after.mastery - before.mastery) < 1e-6)
  assert.equal(await prisma.reviewSchedule.count({ where: { userId: w.user.id } }), 1)
})

dbTest('regrade replaces events on every concept the session touched', async () => {
  const w = await world()
  const ids = w.concepts.map((c) => c.id)
  await mod.recordEvidence([answer(w, { conceptIds: ids, score: 0, sessionKey: 'multi' })])
  await mod.recordEvidence([answer(w, { conceptIds: [ids[0]], score: 1, sessionKey: 'multi' })], {
    replaceSessionKeys: ['multi'],
  })
  const events = await prisma.evidenceEvent.findMany({ where: { userId: w.user.id } })
  assert.equal(events.length, 1)
  const other = await prisma.conceptMemory.findUniqueOrThrow({
    where: { userId_conceptId: { userId: w.user.id, conceptId: ids[1] } },
  })
  assert.equal(other.card, null)
  assert.equal(other.consecutiveFails, 0)
})

dbTest('skipIfPresent: the same answer written by two writers at once counts once', async () => {
  const w = await world()
  const sameVoice = () => answer(w, { itemKey: 'voice:sess:0', source: 'voice', sessionKey: 'voice:sess' })
  await Promise.all([
    mod.recordEvidence([sameVoice()], { skipIfPresent: true }),
    mod.recordEvidence([{ ...sameVoice(), sessionKey: 'voice:backfill' }], { skipIfPresent: true }),
  ])
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, itemKey: 'voice:sess:0' } }), 1)
  // The same quiz item under another attempt is a different answer, and is kept.
  await mod.recordEvidence([answer(w, { sessionKey: 'quiz:a1' })], { skipIfPresent: true })
  await mod.recordEvidence([answer(w, { sessionKey: 'quiz:a2' })], { skipIfPresent: true })
  await mod.recordEvidence([answer(w, { sessionKey: 'quiz:a2' })], { skipIfPresent: true })
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, itemKey: 'quiz:set1:0' } }), 2)
})

dbTest('rebuildConcepts: what runs before the replay commits or rolls back with it', async () => {
  const w = await world()
  await mod.recordEvidence([answer(w)])
  await assert.rejects(
    mod.rebuildConcepts(w.user.id, [w.concepts[0].id], 'UTC', async (tx) => {
      await tx.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
      throw new Error('stop')
    })
  )
  assert.equal((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt, null)
  await mod.rebuildConcepts(w.user.id, [w.concepts[0].id], 'UTC', async (tx) => {
    await tx.topic.update({ where: { id: w.topic.id }, data: { evidenceBackfilledAt: new Date() } })
  })
  assert.ok((await prisma.topic.findUniqueOrThrow({ where: { id: w.topic.id } })).evidenceBackfilledAt)
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

dbTest('derived carries lastFailAt, lastInstructionAt and lastIdkAt, and old rows still read', async () => {
  const w = await world()
  const conceptId = w.concepts[0].id
  const t0 = Date.now() - 3 * DAY
  await mod.recordEvidence([answer(w, { itemKey: 'quiz:a:0', score: 0, at: new Date(t0), metadata: { idk: true } })])
  await mod.recordEvidence([answer(w, { itemKey: 'recall:t:all', source: 'recall', score: 0, assistance: 3, at: new Date(t0 + DAY) })])
  const memory = await prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId } } })
  const derived = memory.derived as Record<string, unknown>
  assert.equal(derived.lastFailAt, new Date(t0).toISOString())
  assert.equal(derived.lastIdkAt, new Date(t0).toISOString())
  assert.equal(derived.lastInstructionAt, new Date(t0 + DAY).toISOString())
  const { stateFromMemoryRow } = await import('./mastery')
  const state = stateFromMemoryRow(memory)
  assert.equal(state.lastFailAt?.getTime(), t0)
  assert.equal(state.lastInstructionAt?.getTime(), t0 + DAY)
  // A row written before v3.1 has none of the three keys and reads as null.
  const legacy = stateFromMemoryRow({ ...memory, derived: { delayedNewSuccess: true } })
  assert.equal(legacy.lastFailAt, null)
  assert.equal(legacy.lastInstructionAt, null)
  assert.equal(legacy.lastIdkAt, null)
})
