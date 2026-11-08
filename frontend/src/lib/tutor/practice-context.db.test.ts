/** What the course graph adds to a practice tutor request, read from a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

let prisma: typeof import('@/lib/db/prisma').prisma
let context: typeof import('./practice-context')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  context = await import('./practice-context')
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

/** An id that sorts before (`0`) or after (`f`) any other: the tests give the course order the opposite of the id order. */
const idSorting = (first: '0' | 'f') => `${first}${randomUUID().slice(1)}`

async function course() {
  const user = await prisma.user.create({ data: { email: `pc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = (orderIndex: number) => prisma.topic.create({ data: { projectId: project.id, name: `T${orderIndex}`, orderIndex, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'n.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  const concept = (id: string, topicId: string, name: string, orderIndex: number) =>
    prisma.concept.create({ data: { id, projectId: project.id, topicId, name, summary: `About ${name}`, kind: 'concept', orderIndex } })
  const claim = (conceptId: string, text: string, orderIndex: number) =>
    prisma.conceptClaim.create({ data: { conceptId, text, quote: text, materialId: material.id, orderIndex } })
  return { user, project, topic, concept, claim }
}

test("the claims follow the step's order of its concepts before the cap, not the concepts' ids", async (t) => {
  if (!available) return t.skip('no migrated test database')
  const c = await course()
  const topic = await c.topic(0)
  const first = await c.concept(idSorting('f'), topic.id, 'Graph', 0)
  const second = await c.concept(idSorting('0'), topic.id, 'Heap', 1)
  for (const [concept, name] of [
    [first, 'graph'],
    [second, 'heap'],
  ] as const) {
    for (const n of [0, 1, 2]) await c.claim(concept.id, `A ${name} claim ${n}.`, n)
  }

  const got = await context.loadPracticeContext(c.user.id, c.project.id, [first.id, second.id])
  assert.deepEqual(
    got.claims.map((claim) => claim.text),
    ['A graph claim 0.', 'A graph claim 1.', 'A graph claim 2.', 'A heap claim 0.']
  )
})

test('of two ideas confused with the step equally often, the one earlier in the course is named', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const c = await course()
  const [early, late] = [await c.topic(0), await c.topic(1)]
  const step = await c.concept(randomUUID(), early.id, 'Graph', 0)
  await c.claim(step.id, 'A graph has vertices.', 0)
  const earlier = await c.concept(idSorting('f'), early.id, 'Tree', 1)
  const later = await c.concept(idSorting('0'), late.id, 'Heap', 0)
  // The later idea's edge is written first, so the database's own order would name it.
  for (const other of [later, earlier]) {
    const [sourceId, targetId] = [step.id, other.id].sort()
    await prisma.conceptEdge.create({ data: { projectId: c.project.id, sourceId, targetId, type: 'confusable', weight: 1, confidence: 0.8, status: 'active' } })
  }

  const got = await context.loadPracticeContext(c.user.id, c.project.id, [step.id])
  assert.equal(got.confusable?.name, 'Tree')
})
