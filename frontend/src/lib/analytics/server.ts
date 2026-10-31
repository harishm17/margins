import { cookies } from 'next/headers'
import { captureServerEvent, POSTHOG_COOKIE } from './capture'
import type { AnalyticsEvent } from './config'

/** Server-side funnel event for the request being handled. Fire and forget: a failure is ignored. */
export function trackFromRequest(event: AnalyticsEvent): void {
  void (async () => {
    try {
      const jar = await cookies()
      await captureServerEvent(event, {}, jar.get(POSTHOG_COOKIE)?.value)
    } catch {
      // Outside a request, or no cookie jar: nothing to send.
    }
  })()
}
