import { googleOAuthSettings } from './google-config'
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
}
