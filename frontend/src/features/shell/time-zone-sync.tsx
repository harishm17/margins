'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { readClientCookie, writeClientCookie } from '@/lib/utils/client-cookie'
import { browserTimeZone } from '@/lib/utils/timezone'
import { TIME_ZONE_COOKIE } from '@/lib/learning/time-zone'

/** Writes the cookie when it is missing or has changed (travel). True when it wrote one. */
function rememberTimeZone(): boolean {
  const zone = browserTimeZone()
  const current = readClientCookie(TIME_ZONE_COOKIE)
  if (current && decodeURIComponent(current) === zone) return false
  writeClientCookie(TIME_ZONE_COOKIE, encodeURIComponent(zone))
  return true
}

/**
 * Tells the server the student's time zone, so "today" in the plan is their today. Sets a cookie
 * when it is missing or has changed (travel) and refreshes the page once so it is used. Renders nothing.
 * `serverKnewZone` is whether the cookie came with the request: a page that was drawn without it (it
 * shows a loading shape instead of a plan for the wrong day) is refreshed even if the cookie has been set since.
 */
export function TimeZoneSync({ serverKnewZone = true }: { serverKnewZone?: boolean }) {
  const router = useRouter()
  React.useEffect(() => {
    const changed = rememberTimeZone()
    if (changed || !serverKnewZone) router.refresh()
  }, [router, serverKnewZone])
  return null
}

/**
 * The same cookie, set without a refresh, on every page including the public ones. A student who
 * reaches the app through the home page or the sign-in page already has it, so the first page they
 * see in the app is drawn for their own day straight away.
 */
export function TimeZoneCookie() {
  React.useEffect(() => {
    rememberTimeZone()
  }, [])
  return null
}
