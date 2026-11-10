/**
 * Instruction events and what every surface shows after a miss (spec 18.3, 18.5), against a real, migrated
 * Postgres (DATABASE_URL). Skipped when no database with the evidence_events table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let server: typeof import('./instruction-server')
let evidence: typeof import('./evidence')
let loader: typeof import('./next-activity-server')
let activity: typeof import('./next-activity')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  server = await import('./instruction-server')
  evidence = await import('./evidence')
  loader = await import('./next-activity-server')
  activity = await import('./next-activity')
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

const UP = { ai: 'up' as const, now: new Date(), timeZone: 'UTC' }

async function world() {
  const user = await prisma.user.create({ data: { email: `is-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true, evidenceBackfilledAt: new Date() } })
  const mk = (name: string, orderIndex: number, topicId = topic.id) =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: 's', kind: 'concept', orderIndex } })
  const material = await prisma.material.create({ data: { projectId: project.id, category: 'lecture_notes', filename: 'notes.pdf', gcsPath: 'x', sizeBytes: 1 } })
  return { user, project, topic, mk, material }
}
type World = Awaited<ReturnType<typeof world>>

const miss = (w: World, conceptId: string, n = 0, over: object = {}) => ({
  userId: w.user.id, projectId: w.project.id, topicId: w.topic.id, itemKey: `quiz:m${n}:${conceptId}`, conceptIds: [conceptId], source: 'quiz' as const,
  score: 0, assistance: 0 as const, gradedBy: 'rule' as const, sessionKey: `m${n}-${conceptId}`, ...over,
})

const events = (w: World, source = 'instruction') => prisma.evidenceEvent.findMany({ where: { userId: w.user.id, source }, orderBy: { createdAt: 'asc' } })

dbTest('recordInstruction is idempotent per day', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  const b = await w.mk('B', 1)
  const input = { userId: w.user.id, topicId: w.topic.id, kind: 'pointer' as const, conceptIds: [a.id, b.id], ref: a.id, timeZone: 'UTC' }
  const day1 = new Date('2026-11-10T10:00:00Z')
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: day1 }), { status: 'recorded' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: new Date('2026-11-10T22:00:00Z') }), { status: 'present' })
  assert.equal((await events(w)).length, 2)
  // Another local day is another event, and another ref is another one.
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, at: new Date('2026-11-11T10:00:00Z') }), { status: 'recorded' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...input, ref: b.id, at: day1 }), { status: 'recorded' })
  assert.equal((await events(w)).length, 6)
  // Rows share a timestamp, so find this one by its key rather than by position.
  const row = (await events(w)).find((e) => e.itemKey === `instruction:pointer:${a.id}`)
  assert.ok(row)
  assert.deepEqual([row.source, row.assistance, row.score, row.weight, row.gradedBy], ['instruction', 3, 0, 0, 'rule'])
  assert.deepEqual(row.metadata, { kind: 'pointer' })
  // Two at once write once.
  const race = await Promise.all([1, 2, 3].map(() => server.recordInstruction(prisma, { ...input, ref: 'race', at: day1 })))
  assert.equal(race.filter((r) => r.status === 'recorded').length >= 1, true)
  assert.equal((await prisma.evidenceEvent.count({ where: { userId: w.user.id, itemKey: 'instruction:pointer:race' } })), 2)
})

dbTest('recordInstruction refuses a topic or concepts that are not the student\'s', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  const stranger = await world()
  const theirs = await stranger.mk('Theirs', 0)
  const base = { kind: 'pointer' as const, ref: 'x', timeZone: 'UTC' }
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: stranger.user.id, topicId: w.topic.id, conceptIds: [a.id] }), { status: 'invalid' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [theirs.id] }), { status: 'invalid' })
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [] }), { status: 'invalid' })
  // A mix keeps the student's own concept.
  assert.deepEqual(await server.recordInstruction(prisma, { ...base, userId: w.user.id, topicId: w.topic.id, conceptIds: [a.id, theirs.id] }), { status: 'recorded' })
  assert.equal((await events(w)).length, 1)
  assert.equal((await events(stranger)).length, 0)
})

dbTest('an instruction after a fail clears needsInstruction and sends the student to fresh retrieval', async () => {
  const w = await world()
  const a = await w.mk('A', 0)
  await prisma.topicProgress.create({ data: { userId: w.user.id, topicId: w.topic.id, readAt: new Date(), recallAt: new Date() } })
  const failedAt = new Date(Date.now() - 3600_000)
  await evidence.recordEvidence([miss(w, a.id, 0, { at: failedAt })], { timeZone: 'UTC' })
  const load = () => loader.loadTopicLearningState({ userId: w.user.id, topicId: w.topic.id, timeZone: 'UTC' })
  let state = await load()
  assert.equal(state.concepts[0].needsInstruction, true)
  assert.equal(activity.nextActivity(state, UP).kind, 'instruct')

  await server.recordInstruction(prisma, { userId: w.user.id, topicId: w.topic.id, kind: 'pointer', conceptIds: [a.id], ref: a.id, timeZone: 'UTC' })
  state = await load()
  assert.equal(state.concepts[0].needsInstruction, false)
  // The fail scheduled the concept for tomorrow, so it is not due yet: practice, a different item, not the same retrieval.
  assert.equal(activity.nextActivity(state, UP).kind, 'practice')

  // The instruction moved no card, mastery or due date.
  const memory = await prisma.conceptMemory.findFirstOrThrow({ where: { userId: w.user.id, conceptId: a.id } })
  assert.equal(memory.nAssisted, 0)
  assert.equal(memory.nUnassisted, 1) // the failed quiz itself
  assert.equal(memory.mastery, 0)
})
