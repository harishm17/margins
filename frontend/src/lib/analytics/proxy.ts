import { POSTHOG_API_HOST, POSTHOG_ASSET_HOST, PROXY_PREFIX } from './config'

/**
 * The /m reverse proxy to PostHog (US), so the tracker loads and reports from this site's own origin.
 *
 *   /m/static/*                 -> assets host, cacheable
 *   /m/array/<token>/config(.js) -> assets host, never cached, the browser's Origin forwarded
 *   /m/*                        -> API host: cookies dropped, only a PostHog project key kept as Authorization,
 *                                  X-Forwarded-For set to the visitor's address
 *
 * The visitor's cookies (the sign-in session among them) never leave this server.
 */

const MAX_BODY_BYTES = 1_000_000
const UPSTREAM_TIMEOUT_MS = 10_000
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS'])
/** Request headers worth passing on; everything else (cookie, host, forwarded-*) is not. */
const PASS_HEADERS = ['content-type', 'content-encoding', 'accept', 'accept-language', 'user-agent']

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
}

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } })
}

export async function proxyPosthog(request: Request, fetchImpl: FetchLike = fetch): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== PROXY_PREFIX && !url.pathname.startsWith(`${PROXY_PREFIX}/`)) return plain(404)
  const method = request.method.toUpperCase()
  if (!ALLOWED_METHODS.has(method)) return plain(405, { Allow: 'GET, HEAD, POST, OPTIONS' })
  if (method === 'OPTIONS') {
    return plain(204, {
      'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    })
  }

  const path = url.pathname.slice(PROXY_PREFIX.length) || '/'
  const isConfig = /^\/array\/[^/]+\/config(\.js)?$/.test(path)
  const isAsset = path.startsWith('/static/') || path.startsWith('/array/')
  const host = isAsset ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST
  const target = new URL(`https://${host}${path}${url.search}`)
  if (target.host !== host) return plain(400)

  const headers = new Headers()
  for (const name of PASS_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  let body: ArrayBuffer | undefined
  if (isAsset) {
    // The config answer depends on the page's origin (PostHog checks it), so it is passed on.
    const origin = request.headers.get('origin')
    if (isConfig && origin) headers.set('origin', origin)
  } else {
    if ((request.headers.get('authorization') ?? '').startsWith('Bearer phc_')) {
      headers.set('authorization', request.headers.get('authorization')!)
    }
    const ip = clientIp(request)
    if (ip) headers.set('x-forwarded-for', ip)
    if (method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return plain(413)
      body = await request.arrayBuffer()
      if (body.byteLength > MAX_BODY_BYTES) return plain(413)
    }
  }

  let upstream: Response
  try {
    upstream = await fetchImpl(target.toString(), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return plain(502)
  }

  // The body has been decoded by fetch, so the encoding and length headers no longer describe it.
  const out = new Headers()
  const type = upstream.headers.get('content-type')
  if (type) out.set('Content-Type', type)
  if (isConfig) {
    out.set('Content-Type', path.endsWith('.js') ? 'application/javascript' : 'application/json')
    out.set('Cache-Control', 'no-store')
  } else if (isAsset) {
    out.set('Cache-Control', 'public, max-age=3600')
  } else {
    out.set('Cache-Control', 'no-store')
  }
  if (isAsset) out.set('Access-Control-Allow-Origin', isConfig ? request.headers.get('origin') || '*' : '*')
  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out })
}
