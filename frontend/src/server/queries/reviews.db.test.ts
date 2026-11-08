/**
 * The due list against a real, migrated Postgres (DATABASE_URL). Skipped when no database with the review_schedules
 * table answers.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let reviews: typeof import('./reviews')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  reviews = await import('./reviews')
  available = await prisma.$queryRaw`SELECT 1 FROM review_schedules LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (available) await prisma.$disconnect()
})

const dbTest = (name: string, fn: () => Promise<void>) => test(name, async (t) => (available ? fn() : t.skip('no database')))

dbTest('topics due at the same moment are listed in course order, whatever order their schedules were written in', async () => {
  const user = await prisma.user.create({ data: { email: `due-tie-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  // One moment marks them all due (as a blank exam does); written last topic first.
  const due = new Date(Date.now() - 24 * 3600 * 1000)
  for (const [orderIndex, name] of [...['Sorting', 'Hashing', 'Trees'].entries()].reverse()) {
    const topic = await prisma.topic.create({ data: { projectId: project.id, name, orderIndex, userConfirmed: true } })
    await prisma.reviewSchedule.create({ data: { userId: user.id, projectId: project.id, topicId: topic.id, dueAt: due } })
  }

  const { items } = await reviews.dueReviews(user.id, 'UTC')
  assert.deepEqual(
    items.map((item) => item.topicName),
    ['Sorting', 'Hashing', 'Trees']
  )
})
