import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { statusUrl } from '@/lib/ai/status-tracker'
import { createAiStatusHandler } from './ai-status-request'

const details = { available: true, reason: null, since: null, blocked: null, allowance: null, resetsAt: null } as never

function setup(user: { id: string } | null) {
  const calls: Array<{ userId: string | null; fresh: boolean }> = []
  const handle = createAiStatusHandler({
    getUser: async () => user,
    getStatus: async (userId, options) => {
      calls.push({ userId, fresh: options.fresh })
      return details
    },
    freshLimiter: createRateLimiter({ limit: 1, windowMs: 1000 }),
  })
  return { calls, get: (path: string) => handle(new Request(`http://app.test${path}`)) }
}

test('a signed-out visitor asking for fresh gets the cached answer', async () => {
  const { calls, get } = setup(null)
  const response = await get('/api/ai-status?fresh=1')
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [{ userId: null, fresh: false }])
})

test('a signed-in user gets a fresh read, and only for fresh=1', async () => {
  const { calls, get } = setup({ id: 'u1' })
  await get('/api/ai-status?fresh=1')
  await get('/api/ai-status?fresh=true')
  await get('/api/ai-status')
  assert.deepEqual(calls.map((call) => call.fresh), [true, false, false])
})

test('the page\'s own report-then-refresh request gets a fresh read', async () => {
  const { calls, get } = setup({ id: 'u1' })
  await get(statusUrl(true))
  assert.deepEqual(calls, [{ userId: 'u1', fresh: true }])
})

test('repeat fresh requests inside the window fall back to the cache, per user', async () => {
  const { calls, get } = setup({ id: 'u1' })
  for (let i = 0; i < 5; i++) await get('/api/ai-status?fresh=1')
  assert.deepEqual(calls.map((call) => call.fresh), [true, false, false, false, false])
})

test('one user\'s fresh reads do not use up another user\'s', async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 })
  let current = 'u1'
  const fresh: boolean[] = []
  const handle = createAiStatusHandler({
    getUser: async () => ({ id: current }),
    getStatus: async (_id, options) => (fresh.push(options.fresh), details),
    freshLimiter: limiter,
  })
  const request = () => new Request('http://app.test/api/ai-status?fresh=1')
  await handle(request())
  current = 'u2'
  await handle(request())
  assert.deepEqual(fresh, [true, true])
})
