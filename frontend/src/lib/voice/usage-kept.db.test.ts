/** Voice minutes outlive the course and the account, read from a real, migrated Postgres (DATABASE_URL). */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let query: typeof import('./usage-query')
let claim: typeof import('./claim')
let open: typeof import('./open-sessions')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  query = await import('./usage-query')
  claim = await import('./claim')
  open = await import('./open-sessions')
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
      activeMs: 600_000,
      activeAt: new Date(connectedAt.getTime() + 600_000),
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

/** A student with a course and one voice session that has not run a turn yet. */
async function studentWithSession() {
  const user = await prisma.user.create({ data: { email: `vu-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const session = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, questionSet: [] } })
  return { user, project, session }
}

test('a tab left open does not use minutes: turns and short pauses count, the heartbeat does not (finding 71)', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project, session } = await studentWithSession()
  const start = new Date(Date.now() - 30 * 60_000)
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000)

  // Turn 1 runs 10 s; the student answers 40 s later and turn 2 runs 10 s. One minute of practice.
  assert.equal((await claim.claimVoiceSession(session, at(0))).ok, true)
  await claim.releaseVoiceTurn(user.id, session.id, true, at(10))
  assert.equal((await claim.claimVoiceSession(session, at(50))).ok, true)
  await claim.releaseVoiceTurn(user.id, session.id, true, at(60))
  // The student walks away; the open tab keeps sending heartbeats for ten minutes.
  await prisma.voiceDrillSession.update({ where: { id: session.id }, data: { lastSeenAt: at(660) } })
  assert.equal((await query.getVoiceUsage(user.id, at(660))).usedSeconds, 80, 'the minute of practice and the 20 s grace')

  // They come back and answer: the long pause counted its grace, and the new turn counts.
  assert.equal((await claim.claimVoiceSession(session, at(700))).ok, true)
  await claim.releaseVoiceTurn(user.id, session.id, true, at(710))
  await prisma.voiceDrillSession.update({ where: { id: session.id }, data: { endedAt: at(710), lastSeenAt: at(710), status: 'ended' } })
  assert.equal((await query.getVoiceUsage(user.id, at(900))).usedSeconds, 90)

  // The database keeps the same figure when the course goes.
  await prisma.project.delete({ where: { id: project.id } })
  assert.equal((await query.getVoiceUsage(user.id, at(900))).usedSeconds, 90)
})

test('a first turn that failed leaves the session unconnected and unused', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, session } = await studentWithSession()
  const now = new Date()
  assert.equal((await claim.claimVoiceSession(session, now)).ok, true)
  await claim.releaseVoiceSession(session.id)
  await claim.releaseVoiceTurn(user.id, session.id, true, new Date(now.getTime() + 5000))
  const usage = await query.getVoiceUsage(user.id, new Date(now.getTime() + 6000))
  assert.equal(usage.usedSeconds, 0)
  assert.equal(usage.hasLiveSession, false)
})

test('one open voice practice: a start elsewhere is refused, "Start here instead" ends the other, a session nobody ended is closed (findings 85, 128)', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project, session } = await studentWithSession()
  const now = new Date()
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)
  // A session whose tab died an hour ago, never ended.
  const dead = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, questionSet: [] } })
  await prisma.voiceDrillSession.update({ where: { id: dead.id }, data: { connectedAt: ago(3700), lastSeenAt: ago(3600), activeMs: 60_000, activeAt: ago(3640) } })
  // And one open right now in another tab.
  assert.equal((await claim.claimVoiceSession(session, ago(10))).ok, true)

  assert.equal(await open.settleOpenSessions(user.id, {}, now), 'busy')
  const closed = await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: dead.id } })
  assert.equal(closed.status, 'aborted')
  assert.equal(closed.endedAt?.getTime(), ago(3600).getTime(), 'closed at its last sign of life')
  assert.equal((await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: session.id } })).status, 'active', 'the open one is left alone')

  assert.equal(await open.settleOpenSessions(user.id, { takeOver: true }, now), 'clear')
  const taken = await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: session.id } })
  assert.equal(taken.status, 'aborted')
  assert.equal((await query.getVoiceUsage(user.id, now)).hasLiveSession, false)
  // The new session's first turn is not refused as busy.
  const next = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, questionSet: [] } })
  assert.equal((await claim.claimVoiceSession(next, now)).ok, true)
})
