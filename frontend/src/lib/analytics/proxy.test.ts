import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RateLimiter } from '@/lib/api/rate-limit'
import { POSTHOG_TOKEN } from './config'
import { clientAddress, proxyPosthog } from './proxy'

type Call = { url: string; init: RequestInit & { headers: Headers } }

function upstream(reply: () => Response = () => new Response('{"status":1}', { headers: { 'content-type': 'application/json' } })) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init as Call['init'] })
    return reply()
  }
  return { calls, fetchImpl }
}

/** A limiter held in the test (the real one counts in the database): `allow` hits per address, then 429. */
function limiter(allow = 1000): RateLimiter & { seen: string[] } {
  const seen: string[] = []
  const hit = async (address: string) => {
    seen.push(address)
    return seen.filter((entry) => entry === address).length <= allow ? { ok: true, retryAfterSeconds: 0 } : { ok: false, retryAfterSeconds: 7 }
  }
  return { check: hit, checkAddress: hit, seen }
}

const SESSION = 'next-auth.session-token=secret-session; ph_phc_x_posthog=abc'
const CAPTURE = 'https://studymargins.com/m/i/v0/e/'

describe('analytics proxy routes', () => {
  it('sends /m/static/* to the assets host and lets browsers cache it', async () => {
    const { calls, fetchImpl } = upstream(() => new Response('/* js */', { headers: { 'content-type': 'application/javascript' } }))
    const res = await proxyPosthog(new Request('https://studymargins.com/m/static/array.js?v=1', { headers: { cookie: SESSION } }), { fetchImpl, limiter: limiter() })
    assert.equal(calls[0].url, 'https://us-assets.i.posthog.com/static/array.js?v=1')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/javascript')
    assert.match(res.headers.get('cache-control') ?? '', /public, max-age=\d+/)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(calls[0].init.headers.get('cookie'), null)
  })

  it('sends the project config to the assets host with the site origin, and only for this app\'s own key', async () => {
    const { calls, fetchImpl } = upstream()
    const ok = await proxyPosthog(
      new Request(`https://studymargins.com/m/array/${POSTHOG_TOKEN}/config`, { headers: { origin: 'https://studymargins.com' } }),
      { fetchImpl, limiter: limiter() }
    )
    assert.equal(ok.status, 200)
    assert.equal(calls[0].url, `https://us-assets.i.posthog.com/array/${POSTHOG_TOKEN}/config`)
    assert.equal(calls[0].init.headers.get('origin'), 'https://studymargins.com')
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://studymargins.com')
    const other = await proxyPosthog(new Request('https://studymargins.com/m/array/phc_someoneelse/config'), { fetchImpl, limiter: limiter() })
    assert.equal(other.status, 404)
    assert.equal(calls.length, 1)
  })

  it('sends a capture to the API host with the body, without cookies, and with the visitor address', async () => {
    const { calls, fetchImpl } = upstream()
    const body = `{"api_key":"${POSTHOG_TOKEN}","event":"quiz_started"}`
    const res = await proxyPosthog(
      new Request(`${CAPTURE}?ip=0`, {
        method: 'POST',
        body,
        headers: { cookie: SESSION, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', authorization: `Bearer ${POSTHOG_TOKEN}` },
      }),
      { fetchImpl, limiter: limiter() }
    )
    const [call] = calls
    assert.equal(call.url, 'https://us.i.posthog.com/i/v0/e/?ip=0')
    assert.equal(call.init.method, 'POST')
    assert.equal(new TextDecoder().decode(call.init.body as ArrayBuffer), body)
    assert.equal(call.init.headers.get('cookie'), null)
    assert.equal(call.init.headers.get('authorization'), `Bearer ${POSTHOG_TOKEN}`)
    assert.equal(call.init.headers.get('content-type'), 'application/json')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('trusts only the last x-forwarded-for entry (the one Railway appends), never x-real-ip', async () => {
    const forwarded = limiter()
    const { calls, fetchImpl } = upstream()
    await proxyPosthog(
      new Request(CAPTURE, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-real-ip': '1.2.3.4' } }),
      { fetchImpl, limiter: forwarded }
    )
    assert.deepEqual(forwarded.seen, ['203.0.113.9'])
    assert.equal(calls[0].init.headers.get('x-forwarded-for'), '203.0.113.9')
    assert.equal(clientAddress(new Request(CAPTURE, { headers: { 'x-real-ip': '1.2.3.4' } })), 'unknown')
  })

  it('refuses a project key that is not this app\'s own, in the header or the body', async () => {
    const { calls, fetchImpl } = upstream()
    const withHeader = new Request(CAPTURE, { method: 'POST', body: '{}', headers: { authorization: 'Bearer phc_someoneelse' } })
    assert.equal((await proxyPosthog(withHeader, { fetchImpl, limiter: limiter() })).status, 403)
    const session = new Request(CAPTURE, { method: 'POST', body: '{}', headers: { authorization: 'Bearer eyJsession' } })
    assert.equal((await proxyPosthog(session, { fetchImpl, limiter: limiter() })).status, 403)
    const withBody = new Request(CAPTURE, { method: 'POST', body: '{"api_key":"phc_someoneelse","event":"x"}', headers: { 'content-type': 'application/json' } })
    assert.equal((await proxyPosthog(withBody, { fetchImpl, limiter: limiter() })).status, 403)
    assert.equal(calls.length, 0)
  })

  it('answers 404 for paths the tracker does not use and 405 for other methods', async () => {
    const { calls, fetchImpl } = upstream()
    const deps = { fetchImpl, limiter: limiter() }
    for (const path of ['/m/api/projects/123/persons', '/m/i/v0/e/../../admin', '/m/array/', '/m/', '/m/static/../secret', '/m/capture/x']) {
      assert.equal((await proxyPosthog(new Request(`https://studymargins.com${path}`, { method: 'POST', body: '{}' }), deps)).status, 404, path)
    }
    assert.equal((await proxyPosthog(new Request(CAPTURE, { method: 'DELETE' }), deps)).status, 405)
    assert.equal((await proxyPosthog(new Request(CAPTURE), deps)).status, 405)
    assert.equal((await proxyPosthog(new Request('https://studymargins.com/m/static/array.js', { method: 'POST', body: '{}' }), deps)).status, 405)
    assert.equal(calls.length, 0)
  })

  it('answers the preflight only for the site\'s own origin', async () => {
    const deps = { fetchImpl: upstream().fetchImpl, limiter: limiter() }
    const own = await proxyPosthog(new Request(CAPTURE, { method: 'OPTIONS', headers: { origin: 'https://studymargins.com' } }), deps)
    assert.equal(own.status, 204)
    assert.equal(own.headers.get('access-control-allow-origin'), 'https://studymargins.com')
    const foreign = await proxyPosthog(new Request(CAPTURE, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps)
    assert.equal(foreign.status, 403)
    assert.equal(foreign.headers.get('access-control-allow-origin'), null)
  })

  it('refuses a body over 1 MB with 413, whether or not it states a length, and stops reading at the cap', async () => {
    const { calls, fetchImpl } = upstream()
    const deps = { fetchImpl, limiter: limiter() }
    const stated = await proxyPosthog(new Request(CAPTURE, { method: 'POST', body: 'x'.repeat(1_000_001) }), deps)
    assert.equal(stated.status, 413)

    // A chunked body has no Content-Length: the reader must count as it goes.
    let pulled = 0
    const chunk = new Uint8Array(100_000)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 1000) return controller.close()
        controller.enqueue(chunk)
      },
    })
    const chunked = new Request(CAPTURE, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    assert.equal(chunked.headers.get('content-length'), null)
    assert.equal((await proxyPosthog(chunked, deps)).status, 413)
    assert.ok(pulled < 100, `read ${pulled} chunks of a 100 MB stream`)
    assert.equal(calls.length, 0)
  })

  it('answers 429 once an address is over its limit, and counts addresses apart', async () => {
    const { calls, fetchImpl } = upstream()
    const deps = { fetchImpl, limiter: limiter(2) }
    const send = (address: string) =>
      proxyPosthog(new Request(CAPTURE, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': address } }), deps)
    assert.equal((await send('198.51.100.4')).status, 200)
    assert.equal((await send('198.51.100.4')).status, 200)
    const refused = await send('198.51.100.4')
    assert.equal(refused.status, 429)
    assert.equal(refused.headers.get('retry-after'), '7')
    assert.equal((await send('198.51.100.5')).status, 200)
    assert.equal(calls.length, 3)
  })

  it('answers 502 when PostHog is unreachable', async () => {
    const down = async () => {
      throw new Error('offline')
    }
    assert.equal((await proxyPosthog(new Request(CAPTURE, { method: 'POST', body: '{}' }), { fetchImpl: down, limiter: limiter() })).status, 502)
  })

  it('passes PostHog errors through (a 4xx from PostHog is still an answer) and hides upstream encoding headers', async () => {
    const { fetchImpl } = upstream(
      () => new Response('{"status":0}', { status: 400, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'x=1', 'content-length': '3' } })
    )
    const res = await proxyPosthog(new Request(CAPTURE, { method: 'POST', body: '{}' }), { fetchImpl, limiter: limiter() })
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('content-length'), null)
  })
})
