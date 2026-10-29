import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedCode, parseStatusResponse, toClientStatus, unreachableStatus } from './status'
import { clearAiStatusCache, getAiStatus } from '@/server/ai-status'

const now = new Date('2026-10-28T15:00:00Z')

test('an available AI with the allowance partly used', () => {
  const status = parseStatusResponse(
    {
      available: true,
      reason: null,
      since: null,
      allowance: { used: 2, limit: 8, resets_at: '2026-10-29T00:00:00Z' },
      global_cap_hit: false,
      resets_at: '2026-10-29T00:00:00Z',
    },
    now
  )
  assert.equal(status.available, true)
  assert.deepEqual(status.allowance, { used: 2, limit: 8, resetsAt: '2026-10-29T00:00:00Z', usedFraction: 0.25, exhausted: false })
  assert.equal(blockedCode(status), null)
})

test('a provider outage blocks with its reason', () => {
  const status = parseStatusResponse({ available: false, reason: 'LLM_CREDIT_EXHAUSTED', since: '2026-10-28T09:00:00Z' }, now)
  assert.equal(blockedCode(status), 'LLM_CREDIT_EXHAUSTED')
  assert.equal(status.since, '2026-10-28T09:00:00Z')
})

test('the allowance used, or the global cap hit, blocks with the allowance code', () => {
  const used = parseStatusResponse({ available: true, allowance: { used: 8.2, limit: 8 } }, now)
  assert.equal(blockedCode(used), 'LLM_DAILY_BUDGET')
  const global = parseStatusResponse({ available: true, global_cap_hit: true }, now)
  assert.equal(blockedCode(global), 'LLM_DAILY_BUDGET')
  // No per-user cap.
  const uncapped = parseStatusResponse({ available: true, allowance: { used: 100, limit: null } }, now)
  assert.equal(blockedCode(uncapped), null)
  assert.equal(uncapped.allowance?.usedFraction, null)
})

test('the browser never gets dollar figures', () => {
  const client = toClientStatus(parseStatusResponse({ available: true, allowance: { used: 6, limit: 8 } }, now))
  assert.deepEqual(client.allowance, { usedFraction: 0.75, exhausted: false, resetsAt: '2026-10-29T00:00:00.000Z' })
  assert.doesNotMatch(JSON.stringify(client), /"used"|"limit"/)
})

test('a malformed answer reads as available, an unreachable service as unavailable', () => {
  assert.equal(parseStatusResponse('nonsense', now).available, true)
  assert.equal(blockedCode(unreachableStatus(now)), 'AI_UNREACHABLE')
})

function fakeFetch(answers: Array<unknown | Error>) {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(String(url))
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('getAiStatus asks the AI service with the user, caches briefly and does not cache a failure', async () => {
  clearAiStatusCache()
  let clock = 1_000
  const { impl, calls } = fakeFetch([
    new Error('connection refused'),
    { available: false, reason: 'LLM_CREDIT_EXHAUSTED', since: '2026-10-28T09:00:00Z' },
    { available: true },
  ])
  const options = { fetchImpl: impl, now: () => clock }

  assert.equal((await getAiStatus('u1', options)).reason, 'AI_UNREACHABLE')
  assert.equal((await getAiStatus('u1', options)).reason, 'LLM_CREDIT_EXHAUSTED')
  clock += 1_000
  assert.equal((await getAiStatus('u1', options)).reason, 'LLM_CREDIT_EXHAUSTED', 'cached')
  clock += 20_000
  assert.equal((await getAiStatus('u1', options)).available, true)
  assert.equal(calls.length, 3)
  assert.match(calls[0], /\/status\/ai\?user_id=u1$/)
})

test('a fresh read skips the cache and refreshes it for the next readers', async () => {
  clearAiStatusCache()
  const { impl, calls } = fakeFetch([{ available: true }, { available: false, reason: 'LLM_CREDIT_EXHAUSTED' }])
  const options = { fetchImpl: impl, now: () => 1_000 }
  assert.equal((await getAiStatus('u2', options)).available, true)
  assert.equal((await getAiStatus('u2', { ...options, fresh: true })).reason, 'LLM_CREDIT_EXHAUSTED')
  assert.equal((await getAiStatus('u2', options)).reason, 'LLM_CREDIT_EXHAUSTED', 'cached fresh answer')
  assert.equal(calls.length, 2)
})
