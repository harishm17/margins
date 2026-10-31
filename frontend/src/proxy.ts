import { NextResponse, type NextRequest } from 'next/server'

/**
 * Passes the requested path to server components in a header, so a layout can send a signed-out
 * visitor to /login?next=<where they were going>. Layouts cannot read the URL themselves.
 */
export function proxy(request: NextRequest) {
  // next.config.js turns off Next's own trailing-slash redirect (PostHog posts to /m/i/v0/e/, and a redirect would
  // drop the body), so the redirect for every other path is done here.
  const { pathname, search } = request.nextUrl
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return NextResponse.redirect(new URL(pathname.replace(/\/+$/, '') + search, request.url), 308)
  }
  const headers = new Headers(request.headers)
  headers.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ['/((?!api|m/|_next/static|_next/image|favicon.ico|screens|.*\\.[a-zA-Z0-9]+$).*)'],
}
