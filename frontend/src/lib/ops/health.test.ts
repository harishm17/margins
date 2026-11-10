import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdsInternalToken, publicHealthBody, readiness, WATCHDOG_STALE_MS } from './health'

const now = new Date('2026-11-09T12:00:00Z')
const fresh = new Date(now.getTime() - 60_000).toISOString()

function checks(overrides: Partial<Parameters<typeof readiness>[0]> = {}) {
  return {
    database: async () => {},
    aiService: async () => true,
    watchdogLastRun: async () => fresh,
    ...overrides,
  }
}

test('ready when the database, the AI service and the watchdog are all fine', async () => {
  assert.deepEqual(await readiness(checks(), now), { ready: true, failed: [] })
})

test('a failing database fails readiness, and the watchdog is not read from it', async () => {
  let read = false
  const result = await readiness(
    checks({
      database: async () => {
        throw new Error('connection refused at 10.0.0.3:5432 password=secret')
      },
      watchdogLastRun: async () => {
        read = true
        return fresh
      },
    }),
    now
  )
  assert.deepEqual(result, { ready: false, failed: ['database'] })
  assert.equal(read, false)
})

test('an AI service that is down or not migrated fails readiness', async () => {
  assert.deepEqual((await readiness(checks({ aiService: async () => false }), now)).failed, ['ai_service'])
  const throwing = checks({
    aiService: async () => {
      throw new Error('timeout')
    },
  })
  assert.deepEqual((await readiness(throwing, now)).failed, ['ai_service'])
})

test('a watchdog that never ran or stopped fails readiness', async () => {
  const stale = new Date(now.getTime() - WATCHDOG_STALE_MS - 1000).toISOString()
  assert.deepEqual((await readiness(checks({ watchdogLastRun: async () => null }), now)).failed, ['watchdog'])
  assert.deepEqual((await readiness(checks({ watchdogLastRun: async () => stale }), now)).failed, ['watchdog'])
  assert.deepEqual((await readiness(checks({ watchdogLastRun: async () => 'not a time' }), now)).failed, ['watchdog'])
})

test('the AI service writes Python ISO times with an offset; they parse', async () => {
  const python = '2026-11-09T11:59:00.123456+00:00'
  assert.equal((await readiness(checks({ watchdogLastRun: async () => python }), now)).ready, true)
})

test('the public body is pass or fail and nothing else', () => {
  assert.deepEqual(publicHealthBody(true), { status: 'ok' })
  assert.deepEqual(publicHealthBody(false), { status: 'unavailable' })
})

test('detail needs the internal token, as a header or a bearer token', () => {
  const expected = 'internal-token-value'
  assert.equal(holdsInternalToken(new Headers(), expected), false)
  assert.equal(holdsInternalToken(new Headers({ 'x-ai-internal-token': 'wrong' }), expected), false)
  assert.equal(holdsInternalToken(new Headers({ 'x-ai-internal-token': expected }), expected), true)
  assert.equal(holdsInternalToken(new Headers({ authorization: `Bearer ${expected}` }), expected), true)
  assert.equal(holdsInternalToken(new Headers({ authorization: 'Bearer nope' }), expected), false)
})

test('with no token configured nobody holds it, not even an empty header', () => {
  assert.equal(holdsInternalToken(new Headers({ 'x-ai-internal-token': '' }), ''), false)
  assert.equal(holdsInternalToken(new Headers({ 'x-ai-internal-token': '' }), undefined), false)
})
