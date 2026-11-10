import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuthSecret } from './secret'

test('uses NEXTAUTH_SECRET when set, in any environment', () => {
  assert.equal(resolveAuthSecret({ NODE_ENV: 'production', NEXTAUTH_SECRET: 'abc' }), 'abc')
  assert.equal(resolveAuthSecret({ NODE_ENV: 'development', NEXTAUTH_SECRET: 'abc' }), 'abc')
})

test('production without a secret throws', () => {
  assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production' }), /NEXTAUTH_SECRET is not set/)
})

test('the production build does not need the secret', () => {
  assert.ok(resolveAuthSecret({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }).length > 0)
})
