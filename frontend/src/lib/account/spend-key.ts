import { createHmac } from 'node:crypto'

const DEV_FALLBACK_SECRET = 'margins-dev-spend-key-secret'

/**
 * The secret that keys the spend key. Like the session secret (lib/auth/secret.ts): required in production,
 * fixed in development and tests, and not needed to compile pages. Never rotate it: a new value gives every
 * returning student a new key, and with it a fresh daily allowance and fresh voice minutes.
 */
export function resolveSpendKeySecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.SPEND_KEY_SECRET
  if (secret) return secret
  const building = env.NEXT_PHASE === 'phase-production-build'
  if (env.NODE_ENV === 'production' && !building) {
    throw new Error(
      'SPEND_KEY_SECRET is not set. Set it once to a long random string (for example `openssl rand -hex 32`) and never change it.'
    )
  }
  return DEV_FALLBACK_SECRET
}

export type SpendIdentity = {
  email: string
  oauthProvider?: string | null
  oauthId?: string | null
}

/**
 * The one-way key for the person behind an account: an HMAC of their Google account id (their lowercase email when
 * the account has no Google id, as in local test sign-ins). The same Google account gets the same key after the
 * account is deleted and created again, so the daily AI allowance and the voice minutes they used today stay used.
 * Nothing about the person can be read back from it.
 */
export function computeSpendKey(identity: SpendIdentity, secret = resolveSpendKeySecret()): string {
  const subject =
    identity.oauthProvider === 'google' && identity.oauthId
      ? `google:${identity.oauthId}`
      : `email:${identity.email.trim().toLowerCase()}`
  return createHmac('sha256', secret).update(subject).digest('hex')
}
