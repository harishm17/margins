/** The terms of a topic's concepts and claims, read from a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let terms: typeof import('./course-terms')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  terms = await import('./course-terms')
  available = await prisma.$queryRaw`SELECT coach_state FROM voice_drill_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
})
after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

test('a topic gives its active concepts in order, then terms from their claims; a removed concept is left out', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `ct-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Graphs', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'n.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const make = (name: string, orderIndex: number, status = 'active') =>
    prisma.concept.create({ data: { projectId: project.id, topicId: topic.id, name, summary: 's', kind: 'concept', orderIndex, status } })
  const second = await make('Shortest path', 1)
  const first = await make('Graph', 0)
  await make('Retired idea', 2, 'removed')
  await prisma.conceptClaim.create({ data: { conceptId: second.id, text: 'Dijkstra finds the shortest path when no edge weight is negative.', quote: 'q', materialId: material.id, orderIndex: 0 } })
  await prisma.conceptClaim.create({ data: { conceptId: first.id, text: 'A graph has vertices joined by edges.', quote: 'q', materialId: material.id, orderIndex: 0 } })

  const got = await terms.courseTermsForTopics(user.id, [topic.id])
  assert.deepEqual(got.slice(0, 2), ['Graph', 'Shortest path'])
  assert.ok(got.includes('Dijkstra'))
  assert.equal(got.includes('Retired idea'), false)
  assert.deepEqual(await terms.courseTermsForTopics(user.id, []), [])
})

test("several topics' terms come in course order, not in the order of the topics' ids", async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `ct-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  // The course's first topic has the larger id, so an order by topic id would put it last.
  const earlier = await prisma.topic.create({ data: { id: `f${crypto.randomUUID().slice(1)}`, projectId: project.id, name: 'Graphs', orderIndex: 0, userConfirmed: true } })
  const later = await prisma.topic.create({ data: { id: `0${crypto.randomUUID().slice(1)}`, projectId: project.id, name: 'Heaps', orderIndex: 1, userConfirmed: true } })
  await prisma.concept.create({ data: { projectId: project.id, topicId: later.id, name: 'Heap', summary: 's', kind: 'concept', orderIndex: 0 } })
  await prisma.concept.create({ data: { projectId: project.id, topicId: earlier.id, name: 'Graph', summary: 's', kind: 'concept', orderIndex: 0 } })

  const got = await terms.courseTermsForTopics(user.id, [later.id, earlier.id])
  assert.deepEqual(got.slice(0, 2), ['Graph', 'Heap'])
})
