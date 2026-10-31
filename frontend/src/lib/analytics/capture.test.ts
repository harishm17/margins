import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { captureServerEvent, distinctIdFromCookie, POSTHOG_COOKIE } from './capture'

const prod = { NEXTAUTH_URL: 'https://studymargins.com' }
const cookie = JSON.stringify({ distinct_id: '019a-visitor', $sesid: [1, 'x', 'y'] })

function recorder() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response('{}')
  }
  return { calls, fetchImpl }
}

describe('distinctIdFromCookie', () => {
  it('reads the id from plain and URL-encoded cookie values', () => {
    assert.equal(distinctIdFromCookie(cookie), '019a-visitor')
    assert.equal(distinctIdFromCookie(encodeURIComponent(cookie)), '019a-visitor')
  })
  it('is null for nothing usable', () => {
    for (const value of [undefined, null, '', 'not json', '{}', '{"distinct_id":5}']) assert.equal(distinctIdFromCookie(value), null)
  })
  it('names the cookie the tracker keeps', () => {
    assert.equal(POSTHOG_COOKIE, 'ph_phc_nT2JxCxLcAiSQGP4d4iJ2mWef6k3gNa6ptFaEJmz5cJ9_posthog')
  })
})

describe('captureServerEvent', () => {
  it('sends the event under the browser id with the site, and nothing about the student', async () => {
    const { calls, fetchImpl } = recorder()
    await captureServerEvent('signup_completed', {}, cookie, { env: prod, fetchImpl })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://us.i.posthog.com/i/v0/e/')
    const { body } = calls[0]
    assert.equal(body.event, 'signup_completed')
    assert.equal(body.distinct_id, '019a-visitor')
    assert.deepEqual(Object.keys(body.properties as object).sort(), ['$geoip_disable', '$process_person_profile', 'site'])
    assert.equal((body.properties as { site: string }).site, 'margins')
  })

  it('sends nothing off the production site, without the tracker cookie, or when PostHog fails', async () => {
    const { calls, fetchImpl } = recorder()
    await captureServerEvent('login_completed', {}, cookie, { env: { NEXTAUTH_URL: 'http://localhost:3000' }, fetchImpl })
    await captureServerEvent('login_completed', {}, cookie, { env: {}, fetchImpl })
    await captureServerEvent('login_completed', {}, undefined, { env: prod, fetchImpl })
    assert.equal(calls.length, 0)
    await captureServerEvent('login_completed', {}, cookie, {
      env: prod,
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
  })
})
