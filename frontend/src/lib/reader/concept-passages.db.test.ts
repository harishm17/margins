/**
 * The passages of the reader that hold a concept's claims, against a real, migrated Postgres (DATABASE_URL).
 * Skipped when no database with the margin_notes table answers.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let passages: typeof import('./concept-passages')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  passages = await import('./concept-passages')
  available = await prisma.$queryRaw`SELECT 1 FROM margin_notes LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

async function world(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Hash tables', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'notes.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1, validationStatus: 'valid' } })
  const chunks = []
  for (const [index, text] of ['A hash function maps a key to an index.', 'Open addressing probes for a free bucket.', 'Chaining keeps a list in each bucket.'].entries()) {
    chunks.push(await prisma.materialChunk.create({ data: { materialId: material.id, chunkText: text, chunkIndex: index, pageStart: 3 + index, pageEnd: 3 + index } }))
  }
  await prisma.topicSource.create({ data: { topicId: topic.id, materialId: material.id, chunkIndexStart: 0, chunkIndexEnd: 2, role: 'primary' } })
  const concept = await prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name: 'Collision', summary: 'c', kind: 'concept', orderIndex: 0, objectiveIndexes: [] } })
  const claim = (n: number, chunkId: string | null) => prisma.conceptClaim.create({ data: { conceptId: concept.id, text: `claim ${n}`, quote: `quote ${n}`, materialId: material.id, chunkId, orderIndex: n, pageStart: 3 } })
  // The first claim is on the last chunk; the second on the first; the third has no passage; the fourth repeats the first.
  await claim(0, chunks[2].id)
  await claim(1, chunks[0].id)
  await claim(2, null)
  await claim(3, chunks[0].id)
  return { user, topic, concept, chunks }
}

test('the passages of a concept are its claims\' chunks in reading order, once each', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('cp-order')
  assert.deepEqual(await passages.conceptPassageIds(w.user.id, w.topic.id, w.concept.id), [w.chunks[0].id, w.chunks[2].id])
})

test('another student, another topic or an unknown concept has no passages', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const w = await world('cp-mine')
  const other = await world('cp-other')
  assert.deepEqual(await passages.conceptPassageIds(other.user.id, w.topic.id, w.concept.id), [])
  assert.deepEqual(await passages.conceptPassageIds(w.user.id, other.topic.id, w.concept.id), [])
  assert.deepEqual(await passages.conceptPassageIds(w.user.id, w.topic.id, 'nope'), [])
})
