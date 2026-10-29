import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAuthStartup } from './startup'
import { isLocalRequest, isTestLoginEmail, isTestLoginEnabled, testLoginBlocker } from './test-login'

const SECRET = 'a-long-random-secret-for-tests-only'
const GOOGLE = {
  GOOGLE_OAUTH_CLIENT_ID: '1234567890-abcdefg.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuvwx',
}
const E2E = { NODE_ENV: 'production', NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: 'http://localhost:3104' }

test('off unless ENABLE_TEST_LOGIN is exactly "true"', () => {
  assert.equal(isTestLoginEnabled(E2E), false)
  for (const value of ['', 'false', '0', '1', 'yes', 'TRUE', ' true']) {
    assert.equal(isTestLoginEnabled({ ...E2E, ENABLE_TEST_LOGIN: value }), false, value)
  }
  assert.equal(isTestLoginEnabled({ ...E2E, ENABLE_TEST_LOGIN: 'true' }), true)
})

test('on for a local site: the e2e stack (a production build) and next dev', () => {
  assert.doesNotThrow(() => checkAuthStartup({ ...E2E, ENABLE_TEST_LOGIN: 'true' }))
  const dev = { NODE_ENV: 'development', NEXTAUTH_URL: 'http://localhost:3000', ENABLE_TEST_LOGIN: 'true' }
  assert.equal(isTestLoginEnabled(dev), true)
  assert.doesNotThrow(() => checkAuthStartup(dev))
})

test('never on for the live site: the server refuses to start, with or without Google', () => {
  const live = { NODE_ENV: 'production', NEXTAUTH_SECRET: SECRET, NEXTAUTH_URL: 'https://studymargins.com', ...GOOGLE }
  for (const value of ['true', '1', 'yes', 'TRUE']) {
    assert.throws(() => checkAuthStartup({ ...live, ENABLE_TEST_LOGIN: value }), /ENABLE_TEST_LOGIN is set/, value)
  }
  assert.equal(isTestLoginEnabled({ ...live, ENABLE_TEST_LOGIN: 'true' }), false)
  assert.doesNotThrow(() => checkAuthStartup({ ...live, ENABLE_TEST_LOGIN: 'false' }))
})

test('never on under Railway, even when NEXTAUTH_URL says localhost (railway run, a misset variable)', () => {
  for (const marker of ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_PUBLIC_DOMAIN']) {
    const env = { ...E2E, ...GOOGLE, ENABLE_TEST_LOGIN: 'true', [marker]: 'x' }
    assert.equal(isTestLoginEnabled(env), false, marker)
    assert.match(testLoginBlocker(env) ?? '', /Railway/)
    assert.throws(() => checkAuthStartup(env), /ENABLE_TEST_LOGIN is set, but it is running on Railway/)
  }
})

test('never on without a NEXTAUTH_URL on this machine, in development too', () => {
  for (const NEXTAUTH_URL of [undefined, '', 'not a url', 'http://192.168.1.20:3000', 'https://box.tail1234.ts.net']) {
    const env = { NODE_ENV: 'development', NEXTAUTH_URL, ENABLE_TEST_LOGIN: 'true' }
    assert.equal(isTestLoginEnabled(env), false, String(NEXTAUTH_URL))
    assert.throws(() => checkAuthStartup(env), /ENABLE_TEST_LOGIN is set/)
  }
})

test('each sign-in must arrive on a loopback host, with no proxy in front', () => {
  assert.equal(isLocalRequest({ host: 'localhost:3104' }), true)
  assert.equal(isLocalRequest({ host: '127.0.0.1:3000' }), true)
  assert.equal(isLocalRequest({ host: 'studymargins.com' }), false)
  assert.equal(isLocalRequest({ host: 'localhost:3000', 'x-forwarded-host': 'studymargins.com' }), false)
  assert.equal(isLocalRequest({}), false)
  assert.equal(isLocalRequest(undefined), false)
})

test('only @example.com addresses', () => {
  assert.equal(isTestLoginEmail('smoke-1@example.com'), true)
  assert.equal(isTestLoginEmail('Demo@Example.com'), true)
  for (const email of ['harish@gmail.com', 'demo@studymargins.com', 'a@example.com.evil.com', 'a@notexample.com', 'a@sub.example.com', '@example.com', '']) {
    assert.equal(isTestLoginEmail(email), false, email)
  }
})
