/** Turn timings stored against a real, migrated Postgres (DATABASE_URL), with the browser's numbers attached a turn later. */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/db/prisma').prisma
let timing: typeof import('./turn-timing')
let available = false
const userIds: string[] = []

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  timing = await import('./turn-timing')
  available = await prisma.$queryRaw`SELECT total_ms FROM voice_turn_timings LIMIT 1`.then(
    () => true,
    () => false
  )
})
after(async () => {
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

test('a turn is stored once, the browser numbers join the turn before, and the summary reads them back', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const user = await prisma.user.create({ data: { email: `tm-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  const session = await prisma.voiceDrillSession.create({ data: { userId: user.id, projectId: project.id, style: 'teach_back', questionSet: [] } })
  const base = { sessionId: session.id, userId: user.id, style: 'teach_back', preRun: 'assess', graded: true, stepMs: 600, ok: true }
  const lines: string[] = []
  await timing.recordTurnTiming({ ...base, turn: 2, calls: [{ ttftMs: 1000, totalMs: 1400 }], firstTextMs: 1800, totalMs: 2200 }, (line) => lines.push(line))
  await timing.recordTurnTiming({ ...base, turn: 2, calls: [], firstTextMs: 1, totalMs: 1 }, () => undefined)
  await timing.recordTurnTiming({ ...base, turn: 3, preRun: null, graded: false, stepMs: 0, calls: [{ ttftMs: 900, totalMs: 1200 }, { ttftMs: null, totalMs: 100 }], firstTextMs: null, totalMs: 1400 }, () => undefined)
  assert.equal(lines.length, 1)
  // Turn 3 arrives with the browser's numbers for turn 2.
  await timing.attachClientTiming(session.id, 3, { endpointWaitMs: 1200, requestToFirstSentenceMs: 2100, interrupted: false })
  await timing.attachClientTiming(session.id, 4, {})
  const rows = await prisma.voiceTurnTiming.findMany({ where: { sessionId: session.id }, orderBy: { turn: 'asc' } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].totalMs, 2200, 'the first record of a turn stays')
  assert.deepEqual(rows[0].client, { endpointWaitMs: 1200, requestToFirstSentenceMs: 2100, interrupted: false })
  assert.equal(rows[1].client, null)
  assert.equal(rows[1].modelCalls, 2)
  const [graded, other] = timing.summarizeTimings(rows)
  assert.equal(graded.graded, true)
  assert.equal(graded.clientFirstSentence.p50, 2100)
  assert.equal(other.graded, false)
  assert.equal(other.firstText.p50, null)
})
