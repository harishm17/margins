import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { proxyPosthog } from './proxy'

type Call = { url: string; init: RequestInit & { headers: Headers } }

function upstream(reply: () => Response = () => new Response('{"status":1}', { headers: { 'content-type': 'application/json' } })) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init as Call['init'] })
    return reply()
  }
  return { calls, fetchImpl }
}

const SESSION = 'next-auth.session-token=secret-session; ph_phc_x_posthog=abc'

describe('analytics proxy routes', () => {
  it('sends /m/static/* to the assets host and lets browsers cache it', async () => {
    const { calls, fetchImpl } = upstream(() => new Response('/* js */', { headers: { 'content-type': 'application/javascript' } }))
    const res = await proxyPosthog(new Request('https://studymargins.com/m/static/array.js?v=1', { headers: { cookie: SESSION } }), fetchImpl)
    assert.equal(calls[0].url, 'https://us-assets.i.posthog.com/static/array.js?v=1')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/javascript')
    assert.match(res.headers.get('cache-control') ?? '', /public, max-age=\d+/)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(calls[0].init.headers.get('cookie'), null)
  })

  it('sends everything else to the API host with the body, without cookies, and with the visitor address', async () => {
    const { calls, fetchImpl } = upstream()
    const body = '{"api_key":"phc_abc","event":"quiz_started"}'
    const res = await proxyPosthog(
      new Request('https://studymargins.com/m/i/v0/e/?ip=0', {
        method: 'POST',
        body,
        headers: { cookie: SESSION, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', authorization: 'Bearer phc_abc' },
      }),
      fetchImpl
    )
    const [call] = calls
    assert.equal(call.url, 'https://us.i.posthog.com/i/v0/e/?ip=0')
    assert.equal(call.init.method, 'POST')
    assert.equal(new TextDecoder().decode(call.init.body as ArrayBuffer), body)
    assert.equal(call.init.headers.get('cookie'), null)
    assert.equal(call.init.headers.get('authorization'), 'Bearer phc_abc')
    assert.equal(call.init.headers.get('x-forwarded-for'), '203.0.113.9')
    assert.equal(call.init.headers.get('content-type'), 'application/json')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('prefers x-real-ip and drops an Authorization header that is not a PostHog project key', async () => {
    const { calls, fetchImpl } = upstream()
    await proxyPosthog(
      new Request('https://studymargins.com/m/flags/', {
        method: 'POST',
        body: '{}',
        headers: { 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '1.1.1.1', authorization: 'Bearer eyJsession' },
      }),
      fetchImpl
    )
    assert.equal(calls[0].init.headers.get('x-forwarded-for'), '198.51.100.4')
    assert.equal(calls[0].init.headers.get('authorization'), null)
  })

  it('answers 502 when PostHog is unreachable, and refuses oversized bodies and other methods', async () => {
    const down = async () => {
      throw new Error('offline')
    }
    assert.equal((await proxyPosthog(new Request('https://studymargins.com/m/i/v0/e/', { method: 'POST', body: '{}' }), down)).status, 502)
    const { calls, fetchImpl } = upstream()
    const big = await proxyPosthog(
      new Request('https://studymargins.com/m/i/v0/e/', { method: 'POST', body: 'x'.repeat(1_000_001) }),
      fetchImpl
    )
    assert.equal(big.status, 413)
    assert.equal((await proxyPosthog(new Request('https://studymargins.com/m/i/v0/e/', { method: 'DELETE' }), fetchImpl)).status, 405)
    assert.equal(calls.length, 0)
  })
})
