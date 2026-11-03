/**
 * The quick-pass choice and the plan's current topic, against a real, migrated Postgres (DATABASE_URL). Skipped when
 * no database with the topic_progress table answers.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let server: typeof import('./short-session-server')
let available = false

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  server = await import('./short-session-server')
  available = await prisma.$queryRaw`SELECT 1 FROM topic_progress LIMIT 1`.then(
    () => true,
    () => false
  )
})

async function world() {
  const user = await prisma.user.create({ data: { email: `qp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const topic = await prisma.topic.create({ data: { projectId: project.id, name: 'T', orderIndex: 0, userConfirmed: true } })
  return { user, project, topic }
}

test('a quick pass is set and undone on the topic, with the time it was chosen', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const w = await world()
  assert.deepEqual(await server.quickPassTopicIds(w.user.id, w.project.id), [])
  assert.equal(await server.setQuickPass(w.user.id, w.topic.id, true), 'ok')
  const row = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(row.triage, 'quick')
  assert.ok(row.triageAt)
  assert.deepEqual(await server.quickPassTopicIds(w.user.id, w.project.id), [w.topic.id])

  // Undo puts the full block back and keeps whatever else the row holds.
  await prisma.topicProgress.update({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } }, data: { readAt: new Date() } })
  assert.equal(await server.setQuickPass(w.user.id, w.topic.id, false), 'ok')
  const undone = await prisma.topicProgress.findUniqueOrThrow({ where: { topicId_userId: { topicId: w.topic.id, userId: w.user.id } } })
  assert.equal(undone.triage, null)
  assert.equal(undone.triageAt, null)
  assert.ok(undone.readAt)
  assert.deepEqual(await server.quickPassTopicIds(w.user.id, w.project.id), [])
})

test('only the student\'s own topic can be triaged', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const mine = await world()
  const theirs = await world()
  assert.equal(await server.setQuickPass(mine.user.id, theirs.topic.id, true), 'not_found')
  assert.equal(await server.setQuickPass(mine.user.id, 'no-such-topic', true), 'not_found')
  assert.equal(await prisma.topicProgress.count({ where: { topicId: theirs.topic.id } }), 0)
})
