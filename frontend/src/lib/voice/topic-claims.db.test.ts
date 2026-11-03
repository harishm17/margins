/** Which claims decide whether Teach it back can run from a link (DATABASE_URL, migrated). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let claims: typeof import('./topic-claims')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  claims = await import('./topic-claims')
  available = await prisma.$queryRaw`SELECT 1 FROM concept_claims LIMIT 1`.then(
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
  const user = await prisma.user.create({ data: { email: `tc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  const other = await prisma.topic.create({ data: { projectId: project.id, name: 'Other', orderIndex: 1, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'n.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const idea = (topicId: string, name: string, orderIndex: number, status = 'active') =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: 's', kind: 'concept', orderIndex, status } })
  const withClaims = await idea(topic.id, 'With claims', 0)
  const without = await idea(topic.id, 'Without claims', 1)
  const elsewhere = await idea(other.id, 'Elsewhere', 0)
  await prisma.conceptClaim.create({ data: { conceptId: withClaims.id, text: 'c', quote: 'c', materialId: material.id, orderIndex: 0, pageStart: 1 } })
  await prisma.conceptClaim.create({ data: { conceptId: elsewhere.id, text: 'c', quote: 'c', materialId: material.id, orderIndex: 0, pageStart: 2 } })
  return { topic, other, withClaims, without, elsewhere }
}

dbTest('with no idea named, the topic decides', async () => {
  const w = await world()
  assert.deepEqual(await claims.teachBackClaims(w.topic.id), { hasClaims: true, ofIdea: false })
})

dbTest('with an idea named, its own claims decide: an idea with none is missing them although the topic has some', async () => {
  const w = await world()
  assert.deepEqual(await claims.teachBackClaims(w.topic.id, w.withClaims.id), { hasClaims: true, ofIdea: true })
  assert.deepEqual(await claims.teachBackClaims(w.topic.id, w.without.id), { hasClaims: false, ofIdea: true })
})

dbTest('an idea that is not an active idea of the topic is judged by the topic', async () => {
  const w = await world()
  assert.deepEqual(await claims.teachBackClaims(w.topic.id, w.elsewhere.id), { hasClaims: true, ofIdea: false })
  assert.deepEqual(await claims.teachBackClaims(w.topic.id, 'no-such-id'), { hasClaims: true, ofIdea: false })
  await prisma.concept.update({ where: { id: w.withClaims.id }, data: { status: 'removed' } })
  assert.deepEqual(await claims.teachBackClaims(w.topic.id, w.withClaims.id), { hasClaims: false, ofIdea: false })
})
