import { googleOAuthSettings } from './google-config'
import { resolveSpendKeySecret } from '@/lib/account/spend-key'
import { resolveAuthSecret } from './secret'
import { isDeployed, type Env } from './site'
import { testLoginBlocker, testLoginRequested } from './test-login'

/**
 * Checks the sign-in settings when the server starts, and throws if they are unsafe:
 * - production needs NEXTAUTH_SECRET (secret.ts);
 * - a deployed site needs a real Google OAuth client, because Google is the only way to sign in;
 * - the test sign-in may only be turned on for a local site.
 */
export function checkAuthStartup(env: Env = process.env): void {
  // `next build` only compiles pages; the checks are for the server that will serve them.
  if (env.NEXT_PHASE === 'phase-production-build') return
  resolveAuthSecret(env)
  resolveSpendKeySecret(env)

  if (testLoginRequested(env)) {
    const blocker = testLoginBlocker(env)
    if (blocker) {
      throw new Error(
        `ENABLE_TEST_LOGIN is set, but ${blocker}. The test sign-in lets anyone in without a password, so it ` +
          'only runs on a local site (NEXTAUTH_URL on localhost). Remove ENABLE_TEST_LOGIN.'
      )
    }
  }

  if (isDeployed(env) && !googleOAuthSettings(env)) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are missing or still placeholders. Google is the only ' +
        'way to sign in, so set them to a real OAuth client before starting in production.'
    )
  }

  // Without a bucket the app writes uploads to the container's disk, which a deploy wipes: students would lose
  // their files with no error. The AI service refuses to start without it too (ai-service/app/config.py).
  if (isDeployed(env) && !env.S3_BUCKET?.trim()) {
    throw new Error(
      'S3_BUCKET is not set. A deployed site stores uploads in the bucket; without it they would go to a disk that ' +
        'is lost on every deploy. Set S3_BUCKET (and the S3_* credentials) before starting in production.'
    )
  }
}
