import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGoogleSignIn } from './google-link'

const unlinked = { oauthProvider: null, oauthId: null }

test('an unverified Google email is refused, for new and existing accounts', () => {
  for (const emailVerified of [false, undefined, 'true', 1, null]) {
    for (const existing of [null, unlinked]) {
      assert.deepEqual(
        decideGoogleSignIn({ emailVerified, providerAccountId: 'g1', existing }),
        { action: 'refuse', error: 'GoogleEmailNotVerified' }
      )
    }
  }
})

test('a verified email creates a new account', () => {
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g1', existing: null }), {
    action: 'create',
  })
})

test('a verified email links to an existing unlinked account', () => {
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g1', existing: unlinked }), {
    action: 'link',
  })
})

test('an account already linked to this Google login signs in', () => {
  const existing = { oauthProvider: 'google', oauthId: 'g1' }
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g1', existing }), {
    action: 'allow',
  })
})

test('an account linked to a different Google login is refused', () => {
  const existing = { oauthProvider: 'google', oauthId: 'g1' }
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g2', existing }), {
    action: 'refuse',
    error: 'GoogleAccountMismatch',
  })
})
