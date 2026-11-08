/**
 * What a review reads, against a real, migrated Postgres (DATABASE_URL). Skipped when no database with the
 * concept_memories table answers.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let bank: typeof import('./review-bank')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  bank = await import('./review-bank')
  available = await prisma.$queryRaw`SELECT 1 FROM concept_memories LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

const dbTest = (name: string, fn: () => Promise<void>) => test(name, async (t) => (available ? fn() : t.skip('no database')))

dbTest('ideas that tie for a review come in course order, whatever order their memories were written in', async () => {
  const user = await prisma.user.create({ data: { email: `tie-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const first = await prisma.topic.create({ data: { projectId: project.id, name: 'Sorting', orderIndex: 0, userConfirmed: true } })
  const second = await prisma.topic.create({ data: { projectId: project.id, name: 'Hashing', orderIndex: 1, userConfirmed: true } })
  const concept = (topicId: string, name: string, orderIndex: number) =>
    prisma.concept.create({ data: { projectId: project.id, topicId, name, summary: `${name}.`, kind: 'concept', orderIndex, objectiveIndexes: [] } })
  const ideas = [
    await concept(first.id, 'Compare two keys', 0),
    await concept(first.id, 'Merge two runs', 1),
    await concept(second.id, 'Hash a key', 0),
    await concept(second.id, 'Resolve a collision', 1),
  ]
  // One graded answer tagged with every idea: the same card, the same times, so nothing tells them apart.
  const reviewed = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  const due = new Date(Date.now() - 24 * 3600 * 1000)
  const card = { due: due.toISOString(), stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 2, last_review: reviewed.toISOString() }
  for (const idea of [...ideas].reverse()) {
    await prisma.conceptMemory.create({
      data: { userId: user.id, projectId: project.id, topicId: idea.topicId, conceptId: idea.id, card, dueAt: due, stability: 1, lastReviewAt: reviewed, nUnassisted: 1, lastEvidenceAt: reviewed },
    })
  }

  const context = await bank.loadReviewContext({ userId: user.id, projectId: project.id, now: new Date(), timeZone: 'UTC', withBank: false })
  assert.deepEqual(
    context.due.map((idea) => context.concepts.get(idea.conceptId)?.name),
    ['Compare two keys', 'Merge two runs', 'Hash a key', 'Resolve a collision']
  )
})
