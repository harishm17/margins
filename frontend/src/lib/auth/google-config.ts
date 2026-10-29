import type { Env } from './site'

// Google OAuth client IDs always look like "<digits>-<letters>.apps.googleusercontent.com".
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/
// Template values such as "your-google-client-secret", "changeme" or "...".
const PLACEHOLDER = /your[-_]|change[-_ ]?me|placeholder|example|^[.x*-]+$/i
const MIN_SECRET_LENGTH = 16

/**
 * The Google OAuth client, or null when it is not set up. A value copied from an example file counts
 * as missing, so a server never shows a Google button that can only fail.
 */
export function googleOAuthSettings(env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? ''
  if (!CLIENT_ID.test(clientId)) return null
  if (clientSecret.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(clientSecret)) return null
  return { clientId, clientSecret }
}
