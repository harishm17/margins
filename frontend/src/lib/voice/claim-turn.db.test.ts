/** The one-turn-at-a-time claim of a voice session, against a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let claim: typeof import('./claim')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  claim = await import('./claim')
  available = await prisma.$queryRaw`SELECT turn_started_at FROM voice_drill_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
})
after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

test('a second turn is refused until the first ends, a dead claim expires, and the claim is in the database', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `ct-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const session = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, style: 'teach_back', questionSet: [] } })

  const results = await Promise.all([claim.claimVoiceTurn(session.userId, session.id), claim.claimVoiceTurn(session.userId, session.id)])
  assert.deepEqual(results.filter(Boolean).length, 1, 'two simultaneous turns: one wins')

  await claim.releaseVoiceTurn(session.userId, session.id)
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id), true)

  // A server that died mid-turn left its claim behind: it stops counting after VOICE_TURN_MAX_MS.
  const later = new Date(Date.now() + claim.VOICE_TURN_MAX_MS + 1000)
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id), false)
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id, later), true)
})
