/**
 * The one way the browser writes a cookie the server reads (the time zone, the window's width class): a year, this site only,
 * and Secure whenever the page itself is on https so the value never travels in the clear.
 */
export function writeClientCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax${secure}`
}

/** The cookie's current value as the browser holds it, or undefined. */
export function readClientCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
