/**
 * A brand-new topic is read through its concepts from its first view (finding 94). The AI service marks a topic with no
 * history converted (`topics.evidence_backfilled_at`) in the same transaction that writes its first concepts
 * (ai-service/tests/test_concept_store.py); this proves what the web app does with a topic marked that way:
 * mastery and the explainer gate use the concepts, and two page renders at once both show them.
 * Against a migrated Postgres (DATABASE_URL); skipped without one.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let available = false
let userId = ''
const ids = {} as Record<'project' | 'topic', string>

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  available = await prisma.$queryRaw`SELECT 1 FROM evidence_events LIMIT 1`.then(() => true, () => false)
  if (!available) return
  const user = await prisma.user.create({ data: { email: `p94-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userId = user.id
  const project = await prisma.project.create({ data: { userId, name: 'New topic course' } })
  const material = await prisma.material.create({ data: { projectId: project.id, category: 'lecture_notes', filename: 'n.pdf', gcsPath: 'local://x', sizeBytes: BigInt(1) } })
  // What the concept writer leaves: concepts with claims, and the topic marked converted.
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true, evidenceBackfilledAt: new Date() } })
  for (const [orderIndex, name] of ['Collision', 'Load factor'].entries()) {
    const concept = await prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: `${name}.`, kind: 'concept', orderIndex } })
    await prisma.conceptClaim.create({ data: { conceptId: concept.id, text: `${name} claim`, quote: `${name} quote`, materialId: material.id, orderIndex: 0 } })
  }
  Object.assign(ids, { project: project.id, topic: topic.id })
})

after(async () => {
  if (!prisma) return
  if (available && userId) await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

test('a new topic with its first concepts has concept mastery and an open recall path (94)', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { isConverted } = await import('@/lib/learning/mastery')
  const { hasRecallPath } = await import('@/lib/learning/explainer-server')
  assert.equal(await isConverted(userId, ids.topic), true)
  assert.equal(await hasRecallPath(ids.topic), true)
})

test('two page renders at once both see the concepts (94)', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { getTopicPage } = await import('@/server/queries/topic')
  const pages = await Promise.all([getTopicPage(userId, ids.project, ids.topic), getTopicPage(userId, ids.project, ids.topic)])
  for (const page of pages) {
    assert.deepEqual(page?.concepts.map((concept) => concept.name).sort(), ['Collision', 'Load factor'])
  }
})
