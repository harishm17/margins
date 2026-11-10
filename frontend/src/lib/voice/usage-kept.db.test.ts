/** Voice minutes outlive the course and the account, read from a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let query: typeof import('./usage-query')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  query = await import('./usage-query')
  available = await prisma.$queryRaw`SELECT spend_key FROM voice_usage LIMIT 1`.then(
    () => true,
    () => false
  )
})
after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

test('deleting the course does not give its voice minutes back', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `vu-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const now = new Date()
  const connectedAt = new Date(now.getTime() - 20 * 60_000)
  // A session connects on its first voice turn, which is an update; the database keeps its seconds from then on.
  const session = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, questionSet: [] } })
  await prisma.voiceDrillSession.update({
    where: { id: session.id },
    data: {
      connectedAt,
      lastSeenAt: new Date(connectedAt.getTime() + 600_000),
      endedAt: new Date(connectedAt.getTime() + 600_000),
      status: 'ended',
    },
  })
  const first = await query.getVoiceUsage(user.id, now)
  assert.equal(first.usedSeconds, 600)

  await prisma.project.delete({ where: { id: project.id } })
  const second = await query.getVoiceUsage(user.id, now)
  assert.equal(second.usedSeconds, 600)
  assert.equal(second.remainingSeconds, first.remainingSeconds)
})
