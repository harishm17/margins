import { siteHost, type Env } from '@/lib/auth/site'
import { SITE_HOST } from '@/config/site'
import { ANALYTICS_SITE, POSTHOG_API_HOST, POSTHOG_TOKEN, type AnalyticsEvent, type AnalyticsProps } from './config'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The browser's PostHog id, from the cookie the tracker keeps (ph_<token>_posthog). Null when there is none. */
export function distinctIdFromCookie(value: string | undefined | null): string | null {
  if (!value) return null
  for (const raw of [value, safeDecode(value)]) {
    try {
      const id = (JSON.parse(raw) as { distinct_id?: unknown }).distinct_id
      if (typeof id === 'string' && id.length > 0 && id.length <= 200) return id
    } catch {
      // Try the next form.
    }
  }
  return null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const POSTHOG_COOKIE = `ph_${POSTHOG_TOKEN}_posthog`

/**
 * Send one event from the server under the browser's own PostHog id (for outcomes only the server sees, like
 * the end of the Google sign-in redirect). Only on the production site, only when the visitor's browser runs
 * the tracker (it has the cookie), never throws and never waits for PostHog.
 */
export function captureServerEvent(
  event: AnalyticsEvent,
  props: AnalyticsProps,
  cookieValue: string | undefined | null,
  { env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: FetchLike } = {}
): Promise<void> {
  try {
    if (siteHost(env) !== SITE_HOST) return Promise.resolve()
    const distinctId = distinctIdFromCookie(cookieValue)
    if (!distinctId) return Promise.resolve()
    return fetchImpl(`https://${POSTHOG_API_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_TOKEN,
        event,
        distinct_id: distinctId,
        properties: { ...props, site: ANALYTICS_SITE, $process_person_profile: false, $geoip_disable: true },
      }),
      signal: AbortSignal.timeout(5_000),
    }).then(
      () => undefined,
      () => undefined
    )
  } catch {
    return Promise.resolve()
  }
}
