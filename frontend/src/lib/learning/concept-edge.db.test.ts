/**
 * Confirming and rejecting a suggested link (spec §9), against a real, migrated Postgres (DATABASE_URL).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let edges: typeof import('./concept-edge')
let evidence: typeof import('./evidence')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  edges = await import('./concept-edge')
  evidence = await import('./evidence')
  available = await prisma.$queryRaw`SELECT 1 FROM concept_edges LIMIT 1`.then(
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
  const user = await prisma.user.create({ data: { email: `edge-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const make = (name: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: 's', kind: 'concept', orderIndex } })
  // `advanced` encompasses `basic`: answering advanced well credits basic.
  const advanced = await make('Advanced', 0)
  const basic = await make('Basic', 1)
  const edge = await prisma.conceptEdge.create({
    data: { projectId: project.id, sourceId: advanced.id, targetId: basic.id, type: 'encompasses', weight: 1, confidence: 0.8, status: 'proposed' },
  })
  const answerOn = (conceptId: string) => (sessionKey: string, at: Date) =>
    evidence.recordEvidence(
      [{ userId: user.id, projectId: project.id, topicId: topic.id, itemKey: `quiz:s:${sessionKey}`, conceptIds: [conceptId], source: 'quiz', score: 1, assistance: 0, gradedBy: 'rule', sessionKey, at }],
      { timeZone: 'UTC' }
    )
  return { user, project, topic, advanced, basic, edge, answerOn, answer: answerOn(advanced.id), answerBasic: answerOn(basic.id) }
}

const implicitFor = (userId: string, conceptId: string) => prisma.evidenceEvent.count({ where: { userId, conceptId, source: 'implicit' } })

dbTest('rejecting a link removes the credit it gave and rebuilds the concept', async () => {
  const w = await world()
  const memoryOf = () => prisma.conceptMemory.findUniqueOrThrow({ where: { userId_conceptId: { userId: w.user.id, conceptId: w.basic.id } } })
  // Basic has a card of its own (credit only applies to a concept the student has started), then advanced is answered well.
  await w.answerBasic('first', new Date('2026-11-01T12:00:00Z'))
  const alone = await memoryOf()
  await w.answer('one', new Date('2026-11-11T12:00:00Z'))
  assert.equal(await implicitFor(w.user.id, w.basic.id), 1)
  const credited = await memoryOf()
  assert.notEqual(credited.stability, alone.stability)

  const result = await edges.setEdgeStatus({ userId: w.user.id, edgeId: w.edge.id, status: 'rejected', timeZone: 'UTC' })
  assert.deepEqual(result, { status: 'ok', removedCredit: 1 })

  assert.equal(await implicitFor(w.user.id, w.basic.id), 0)
  const rebuilt = await memoryOf()
  assert.equal(rebuilt.stability, alone.stability)
  assert.equal(rebuilt.dueAt?.getTime(), alone.dueAt?.getTime())
  // What the student did on the advanced concept itself is untouched.
  assert.equal(await prisma.evidenceEvent.count({ where: { userId: w.user.id, conceptId: w.advanced.id, source: 'quiz' } }), 1)
  const row = await prisma.conceptEdge.findUniqueOrThrow({ where: { id: w.edge.id } })
  assert.equal(row.status, 'rejected')
  assert.equal(row.origin, 'student')
})


dbTest("only this student's credit is removed", async () => {
  const w = await world()
  await w.answer('mine', new Date('2026-11-01T12:00:00Z'))
  const other = await prisma.user.create({ data: { email: `edge-other-${Date.now()}@example.com` } })
  userIds.push(other.id)
  await prisma.evidenceEvent.create({
    data: {
      userId: other.id, projectId: w.project.id, topicId: w.topic.id, conceptId: w.basic.id, itemKey: 'x', source: 'implicit', score: 1, assistance: 0,
      weight: 1, role: 'secondary', gradedBy: 'rule', sessionKey: 'o', metadata: { direction: 'credit', pathWeight: 1, edgeId: w.edge.id },
    },
  })
  await edges.setEdgeStatus({ userId: w.user.id, edgeId: w.edge.id, status: 'rejected', timeZone: 'UTC' })
  assert.equal(await implicitFor(w.user.id, w.basic.id), 0)
  assert.equal(await implicitFor(other.id, w.basic.id), 1)
})

dbTest("someone else's link, or a missing one, is not found and changes nothing", async () => {
  const w = await world()
  const stranger = await prisma.user.create({ data: { email: `edge-stranger-${Date.now()}@example.com` } })
  userIds.push(stranger.id)
  assert.deepEqual(await edges.setEdgeStatus({ userId: stranger.id, edgeId: w.edge.id, status: 'rejected', timeZone: 'UTC' }), { status: 'not_found' })
  assert.deepEqual(await edges.setEdgeStatus({ userId: w.user.id, edgeId: 'no-such-edge', status: 'rejected', timeZone: 'UTC' }), { status: 'not_found' })
  assert.equal((await prisma.conceptEdge.findUniqueOrThrow({ where: { id: w.edge.id } })).status, 'proposed')
})

dbTest('a failure while rejecting leaves the link and its credit as they were', async () => {
  const w = await world()
  await w.answerBasic('first', new Date('2026-11-01T12:00:00Z'))
  await w.answer('one', new Date('2026-11-11T12:00:00Z'))
  await assert.rejects(
    edges.setEdgeStatus({ userId: w.user.id, edgeId: w.edge.id, status: 'rejected', timeZone: 'UTC' }, { afterStatusWritten: async () => { throw new Error('boom') } }),
    /boom/
  )
  assert.equal((await prisma.conceptEdge.findUniqueOrThrow({ where: { id: w.edge.id } })).status, 'proposed')
  assert.equal(await implicitFor(w.user.id, w.basic.id), 1)

  const fresh = await world() // nothing reached yet: the status is written in a transaction of its own
  await assert.rejects(
    edges.setEdgeStatus({ userId: fresh.user.id, edgeId: fresh.edge.id, status: 'rejected', timeZone: 'UTC' }, { afterStatusWritten: async () => { throw new Error('boom') } }),
    /boom/
  )
  assert.equal((await prisma.conceptEdge.findUniqueOrThrow({ where: { id: fresh.edge.id } })).status, 'proposed')
})
