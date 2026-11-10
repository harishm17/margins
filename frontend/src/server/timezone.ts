import { cookies } from 'next/headers'
import { resolveTimeZone, TIME_ZONE_COOKIE } from '@/lib/learning/time-zone'

/** The student's time zone from the cookie the browser sets, or UTC before it has. */
export async function getTimeZone(): Promise<string> {
  // Outside a request (a script, a test) there are no cookies: that is the same as the browser not having told us.
  try {
    return resolveTimeZone((await cookies()).get(TIME_ZONE_COOKIE)?.value)
  } catch {
    return resolveTimeZone(undefined)
  }
}

/**
 * The time zone, and whether the browser has told us yet. Before it has (the first request of a
 * browser, or after travel) "today" would be worked out in UTC and then redrawn once the zone is
 * known, which moves everything on the page. Pages that depend on "today" show their loading shape
 * for that one request instead; the app shell sets the cookie and refreshes at once.
 */
export async function getTimeZoneState(): Promise<{ timeZone: string; known: boolean }> {
  const value = (await cookies()).get(TIME_ZONE_COOKIE)?.value
  const timeZone = resolveTimeZone(value)
  let raw = ''
  try {
    raw = decodeURIComponent(value ?? '')
  } catch {
    raw = ''
  }
  // 'UTC' is also what an unusable value resolves to, so a real UTC cookie is told apart by its text.
  return { timeZone, known: raw !== '' && (timeZone !== 'UTC' || raw === 'UTC') }
}
