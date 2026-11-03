import { readClientCookie, writeClientCookie } from '@/lib/utils/client-cookie'

/**
 * Whether the browser window is a phone's width (under 640px, the app's `sm` breakpoint, so what the page calls a phone and what
 * the server calls a phone are the same), told to the server in a cookie (see features/shell/narrow-screen-cookie.tsx). The map
 * page reads it to open on the list, which a phone reads better than a picture that scrolls sideways, without drawing the map
 * first and swapping it.
 */
export const NARROW_COOKIE = 'margins_narrow'

export const NARROW_QUERY = '(max-width: 639px)'

/** True when the cookie says narrow. A browser that has not said yet is not narrow. */
export const isNarrow = (value: string | null | undefined): boolean => value === '1'

/** True when the browser has told the server its width class (either way). A first visit has not. */
export const narrowKnown = (value: string | null | undefined): boolean => value === '0' || value === '1'

/** Tells the server the window's width class for the pages that follow (in the browser only). Writes nothing when it is already so. */
export function writeNarrowCookie(narrow: boolean): void {
  const value = narrow ? '1' : '0'
  if (readClientCookie(NARROW_COOKIE) === value) return
  writeClientCookie(NARROW_COOKIE, value)
}
