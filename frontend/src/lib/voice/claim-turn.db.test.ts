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

  // A turn that is still running renews its claim, so a long turn is never taken for a dead one...
  await claim.releaseVoiceTurn(session.userId, session.id)
  const startedLongAgo = new Date(Date.now() - claim.VOICE_TURN_MAX_MS + 200)
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id, startedLongAgo), true)
  let beats = 0
  const stop = claim.keepVoiceTurn(session.userId, session.id, () => (beats += 1), 30)
  await new Promise((resolve) => setTimeout(resolve, 400))
  stop()
  assert.ok(beats >= 2, 'the reply stream is told the turn is alive at the same pace')
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id), false, 'the renewed claim still holds')
  // ...and a renewal that lands after the turn ended does not bring the claim back.
  await claim.releaseVoiceTurn(session.userId, session.id)
  const late = claim.keepVoiceTurn(session.userId, session.id, undefined, 20)
  await new Promise((resolve) => setTimeout(resolve, 100))
  late()
  assert.equal(await claim.claimVoiceTurn(session.userId, session.id), true)
})
