/**
 * The voice routes against a real, migrated Postgres (DATABASE_URL), with the AI service answered by a stub of `fetch`.
 * Each test names the bug it keeps away. Skipped without a migrated database.
 */
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

type Prisma = typeof import('@/lib/db/prisma').prisma
type Handler = (request: NextRequest) => Promise<Response>

let prisma: Prisma
let setTestSession: typeof import('@/lib/auth/get-session').setTestSession
let turn: Handler
let patchSession: Handler
let available = false
const userIds: string[] = []
const realFetch = globalThis.fetch

/** What the stubbed AI service answers on POST /voice/turn; each test sets it. */
let modelReply: (body: { messages: unknown[] }, signal: AbortSignal | null | undefined) => Response | Promise<Response>
const modelCalls: Array<{ messages: unknown[] }> = []

function ndjson(events: unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event) + '\n').join(''), { status: 200 })
}
const says = (text: string) =>
  ndjson([
    { type: 'text', delta: text },
    { type: 'done', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  ])

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  ;({ setTestSession } = await import('@/lib/auth/get-session'))
  available = await prisma.$queryRaw`SELECT turn_started_at FROM voice_drill_sessions LIMIT 1`.then(
    () => true,
    () => false
  )
  if (!available) return
  turn = (await import('./turn/route')).POST as unknown as Handler
  patchSession = (await import('./session/route')).PATCH as unknown as Handler
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/voice/turn')) {
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] }
      modelCalls.push(body)
      return modelReply(body, init?.signal)
    }
    throw new Error(`unexpected fetch in a voice route test: ${url}`)
  }) as typeof fetch
})
beforeEach(() => {
  modelCalls.length = 0
  modelReply = () => says('Hello.')
})
after(async () => {
  globalThis.fetch = realFetch
  if (!prisma) return
  if (available && userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

async function student() {
  const user = await prisma.user.create({ data: { email: `vr-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com` } })
  userIds.push(user.id)
  setTestSession({ user: { id: user.id, email: user.email, name: null } })
  const project = await prisma.project.create({ data: { userId: user.id, name: 'P' } })
  return { user, project }
}

/** A conversation session: the coach talks without tools, so one model call is the whole turn. */
function conversation(userId: string, projectId: string, timing: { connectedAt?: Date; lastSeenAt?: Date } = {}) {
  return prisma.voiceDrillSession.create({
    data: { userId, projectId, style: 'topic_conversation', questionSet: [], ...timing },
  })
}

const post = (handler: Handler, method: string, path: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${path}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const sayTo = (sessionId: string, utterance: string, extra: Record<string, unknown> = {}) =>
  post(turn, 'POST', '/api/voice/turn', { sessionId, utterance, ...extra })

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { details?: { code?: string } } }
  return body.error?.details?.code
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

test('the daily cap stops a session on a later turn, not only on its first (a minute left once bought an hour)', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project } = await student()
  // Connected 31 minutes ago and still live: the day's 30 minutes are used.
  const session = await conversation(user.id, project.id, { connectedAt: minutesAgo(31), lastSeenAt: new Date() })

  const response = await sayTo(session.id, 'and another thing')
  assert.equal(response.status, 429)
  assert.equal(await errorCode(response), 'VOICE_DAILY_LIMIT')
  assert.equal(modelCalls.length, 0, 'the model is not called past the cap')
  // The refused turn leaves no claim behind: the session can be closed and read as usual.
  const after = await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: session.id } })
  assert.equal(after.turnStartedAt, null)
})

test('a session that went quiet cannot take a turn while another session of the student is live', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project } = await student()
  // The first tab went quiet (a sleeping laptop); the student then started a call in a second tab.
  const quiet = await conversation(user.id, project.id, { connectedAt: minutesAgo(10), lastSeenAt: minutesAgo(5) })
  const live = await conversation(user.id, project.id, { connectedAt: minutesAgo(2), lastSeenAt: new Date() })

  // A heartbeat from the quiet tab does not make it live again...
  const beat = await post(patchSession, 'PATCH', '/api/voice/session', { sessionId: quiet.id, heartbeat: true })
  assert.equal(beat.status, 200)
  const response = await sayTo(live.id, 'still here')
  assert.equal(response.status, 200, 'the live call carries on')
  await response.text()

  // ...and its next turn is refused while the other call is live.
  const refused = await sayTo(quiet.id, 'me too')
  assert.equal(refused.status, 409)
  assert.equal(await errorCode(refused), 'ACTIVE_SESSION')
})

test('ending a call stops it counting as live at once, and a heartbeat already on its way does not reopen it', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project } = await student()
  const first = await conversation(user.id, project.id, { connectedAt: minutesAgo(3), lastSeenAt: new Date() })

  assert.equal((await post(patchSession, 'PATCH', '/api/voice/session', { sessionId: first.id, status: 'ended' })).status, 200)
  assert.equal((await post(patchSession, 'PATCH', '/api/voice/session', { sessionId: first.id, heartbeat: true })).status, 200)

  // The student starts the next call straight away: it is not refused as a second live session.
  const next = await conversation(user.id, project.id)
  const response = await sayTo(next.id, '')
  assert.equal(response.status, 200)
  await response.text()
})

test('two interruptions reported at once are both counted', async (t) => {
  if (!available) return t.skip('no migrated test database')
  const { user, project } = await student()
  const session = await conversation(user.id, project.id)
  await Promise.all(
    Array.from({ length: 6 }, () => post(patchSession, 'PATCH', '/api/voice/session', { sessionId: session.id, incrementInterruptCount: 1 }))
  )
  const after = await prisma.voiceDrillSession.findUniqueOrThrow({ where: { id: session.id } })
  assert.equal(after.interruptCount, 6)
})
