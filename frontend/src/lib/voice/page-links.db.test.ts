/** The pages a wrong voice answer points back to, read from a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

let prisma: typeof import('@/lib/db/prisma').prisma
let links: typeof import('./page-links')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  links = await import('./page-links')
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

test("the pages follow the question's own order of its concepts, not the concepts' ids", async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `pl-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'Graphs', orderIndex: 0, userConfirmed: true } })
  const material = await prisma.material.create({ data: { projectId: project.id, filename: 'n.pdf', category: 'lecture_notes', gcsPath: 'local://x', sizeBytes: 1 } })
  // The question names its first concept with the larger id, so an order by id would put it last.
  const named = (id: string, name: string, orderIndex: number, page: number) =>
    prisma.concept
      .create({ data: { id, projectId: project.id, topicId: topic.id, name, summary: 's', kind: 'concept', orderIndex } })
      .then((concept) =>
        prisma.conceptClaim.create({ data: { conceptId: concept.id, text: name, quote: 'q', materialId: material.id, orderIndex: 0, pageStart: page } })
      )
  const firstNamed = `f${randomUUID().slice(1)}`
  const secondNamed = `0${randomUUID().slice(1)}`
  await named(firstNamed, 'Shortest path', 1, 5)
  await named(secondNamed, 'Graph', 0, 2)

  const got = await links.conceptPageLinks(project.id, [firstNamed, secondNamed])
  assert.deepEqual(
    got.map((link) => link.label),
    ['p. 5', 'p. 2']
  )
})
