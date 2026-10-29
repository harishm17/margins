import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleOAuthSettings } from './google-config'
import { isDeployed, isLoopbackHost } from './site'
import { checkAuthStartup } from './startup'

const SECRET = 'a-long-random-secret-for-tests-only'
const GOOGLE = {
  GOOGLE_OAUTH_CLIENT_ID: '1234567890-abcdefg.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuvwx',
}
const LIVE = { NODE_ENV: 'production', NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: 'https://studymargins.com' }

test('a real Google client is accepted', () => {
  assert.deepEqual(googleOAuthSettings(GOOGLE), {
    clientId: GOOGLE.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE.GOOGLE_OAUTH_CLIENT_SECRET,
  })
})

test('missing, empty and placeholder Google settings count as missing', () => {
  const cases = [
    {},
    { GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' },
    { GOOGLE_OAUTH_CLIENT_ID: GOOGLE.GOOGLE_OAUTH_CLIENT_ID },
    { GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE.GOOGLE_OAUTH_CLIENT_SECRET },
    // The values the .env.example files used to ship, and the README's "...".
    { GOOGLE_OAUTH_CLIENT_ID: 'your-google-client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'your-google-client-secret' },
    { GOOGLE_OAUTH_CLIENT_ID: '...', GOOGLE_OAUTH_CLIENT_SECRET: '...' },
    { GOOGLE_OAUTH_CLIENT_ID: GOOGLE.GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'your-google-client-secret' },
    { GOOGLE_OAUTH_CLIENT_ID: GOOGLE.GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'changeme' },
    { GOOGLE_OAUTH_CLIENT_ID: GOOGLE.GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'xxxxxxxxxxxxxxxxxxxx' },
    { GOOGLE_OAUTH_CLIENT_ID: 'placeholder.apps.googleusercontent.com x', GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE.GOOGLE_OAUTH_CLIENT_SECRET },
  ]
  for (const env of cases) assert.equal(googleOAuthSettings(env), null, JSON.stringify(env))
})

test('a deployed production server will not start without a real Google client', () => {
  assert.throws(() => checkAuthStartup(LIVE), /GOOGLE_OAUTH_CLIENT_ID/)
  assert.throws(
    () => checkAuthStartup({ ...LIVE, GOOGLE_OAUTH_CLIENT_ID: 'your-google-client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'your-google-client-secret' }),
    /placeholders/
  )
  assert.doesNotThrow(() => checkAuthStartup({ ...LIVE, ...GOOGLE }))
})

test('Railway, or a missing NEXTAUTH_URL, counts as deployed even on a localhost URL', () => {
  const local = { NODE_ENV: 'production', NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: 'http://localhost:3000' }
  assert.equal(isDeployed(local), false)
  assert.equal(isDeployed({ ...local, RAILWAY_ENVIRONMENT_NAME: 'production' }), true)
  assert.equal(isDeployed({ ...local, NEXTAUTH_URL: undefined }), true)
  assert.throws(() => checkAuthStartup({ ...local, RAILWAY_PROJECT_ID: 'p' }), /GOOGLE_OAUTH_CLIENT_ID/)
})

test('a local production build (e2e, the image check, docker compose) and development start without Google', () => {
  for (const url of ['http://localhost:3104', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.doesNotThrow(() => checkAuthStartup({ NODE_ENV: 'production', NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: url }))
  }
  assert.doesNotThrow(() => checkAuthStartup({ NODE_ENV: 'development' }))
})

test('production still needs NEXTAUTH_SECRET', () => {
  assert.throws(() => checkAuthStartup({ NODE_ENV: 'production', NEXTAUTH_URL: 'http://localhost:3000' }), /NEXTAUTH_SECRET/)
})

test('loopback hosts, with and without ports', () => {
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:8080', '::1', '[::1]:3000', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['studymargins.com', 'localhost.studymargins.com', '10.0.0.5:3000', '0.0.0.0', '', null, undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('next build is never stopped: the checks run when the server starts', () => {
  assert.doesNotThrow(() =>
    checkAuthStartup({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build', NEXTAUTH_URL: 'https://studymargins.com', ENABLE_TEST_LOGIN: 'true' })
  )
})
