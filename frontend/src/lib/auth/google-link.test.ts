import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGoogleSignIn, GOOGLE_SIGN_IN_ERRORS } from './google-link'

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

test('a password account made before Google-only sign-in links on its first verified Google sign-in, then stays linked', () => {
  // The stored row of an old password account: a hash, but no OAuth login.
  const passwordAccount = { oauthProvider: null, oauthId: null }
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g1', existing: passwordAccount }), {
    action: 'link',
  })
  const linked = { oauthProvider: 'google', oauthId: 'g1' }
  assert.deepEqual(decideGoogleSignIn({ emailVerified: true, providerAccountId: 'g1', existing: linked }), { action: 'allow' })
})

test('every refusal has a message, and none of them points to a password', () => {
  for (const error of ['GoogleEmailNotVerified', 'GoogleAccountMismatch'] as const) {
    const message = GOOGLE_SIGN_IN_ERRORS[error]
    assert.ok(message, error)
    assert.doesNotMatch(message, /password/i)
  }
})
