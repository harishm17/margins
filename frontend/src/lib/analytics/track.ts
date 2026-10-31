import type { AnalyticsEvent, AnalyticsProps } from './config'

type PostHogStub = { capture: (event: string, props?: Record<string, unknown>) => void }

declare global {
  interface Window {
    posthog?: PostHogStub
  }
}

/**
 * Record a funnel event from the browser. Does nothing when the loader (public/hm.js) did not start: another
 * host, an automated browser, an opted-out visitor. Properties are counts and booleans only, by type.
 */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  try {
    window.posthog?.capture(event, props)
  } catch {
    // Analytics never gets in the way of the page.
  }
}
