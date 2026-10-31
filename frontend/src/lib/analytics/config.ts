/**
 * Product analytics (PostHog Cloud US). Everything the browser sends goes through /m on this site's own
 * domain (app/m/[...path]/route.ts), so no third-party origin is ever contacted from a page.
 * The token is a public project token: it can only add events.
 */
export const POSTHOG_TOKEN = 'phc_nT2JxCxLcAiSQGP4d4iJ2mWef6k3gNa6ptFaEJmz5cJ9'
export const POSTHOG_API_HOST = 'us.i.posthog.com'
export const POSTHOG_ASSET_HOST = 'us-assets.i.posthog.com'
/** The path prefix the proxy answers on. The loader (public/hm.js) uses the same one. */
export const PROXY_PREFIX = '/m'
/** Value of the `site` super property: one PostHog project holds several of Harish's sites. */
export const ANALYTICS_SITE = 'margins'

/**
 * The funnel, in the order a student meets it. Properties are counts and booleans only: never a course
 * name, file name, document text, note, grade, email or name.
 */
export type AnalyticsEvent =
  | 'signup_completed'
  | 'login_completed'
  | 'course_created'
  | 'files_uploaded'
  | 'notes_generated'
  | 'quiz_started'
  | 'exam_started'
  | 'plan_created'

export type AnalyticsProps = Record<string, number | boolean>
