import { SITE_HOST } from '@/config/site'
import { createRateLimiter, type RateLimiter } from '@/lib/api/rate-limit'
import { readBodyBytes } from '@/lib/api/read-json'
import { POSTHOG_API_HOST, POSTHOG_ASSET_HOST, POSTHOG_TOKEN, PROXY_PREFIX } from './config'

/**
 * The /m reverse proxy to PostHog (US), so the tracker loads and reports from this site's own origin.
 *
 *   GET  /m/static/*                  -> assets host, cacheable
 *   GET  /m/array/<token>/config(.js) -> assets host, never cached, the browser's Origin forwarded
 *   POST /m/i/v0/e/, /e/, /batch/, /flags/, /decide/ -> API host: cookies dropped, only this app's own project key
 *                                  kept as Authorization, X-Forwarded-For set to the visitor's address
 *
 * It is an open endpoint (no sign-in: the tracker also runs for signed-out visitors), so it forwards only what the
 * tracker sends and nothing else: other paths and methods are 404 / 405, a project key that is not this app's own is
 * refused, a body is read with a size cap whether or not it states a length, and each address gets a durable limit.
 * The visitor's cookies (the sign-in session among them) never leave this server.
 */

const MAX_BODY_BYTES = 1_000_000
const UPSTREAM_TIMEOUT_MS = 10_000
/** Requests per address per minute. A page view or two a minute is typical; this leaves room for a batch of funnel events. */
const REQUESTS_PER_MINUTE = 120
const ALLOWED_HEADERS_LIST = 'GET, POST, OPTIONS'
/** Request headers worth passing on; everything else (cookie, host, forwarded-*) is not. */
const PASS_HEADERS = ['content-type', 'content-encoding', 'accept', 'accept-language', 'user-agent']

/** What the tracker (array.js with feature flags, replay and surveys off) calls on the API host. */
const API_PATHS = new Set(['/i/v0/e/', '/i/v0/e', '/e/', '/e', '/batch/', '/batch', '/flags/', '/flags', '/decide/', '/decide'])
const ASSET_PATH = /^\/static\/[\w./-]+$/
const config = new RegExp(`^/array/${POSTHOG_TOKEN}/config(\\.js)?$`)
const ARRAY_JS = new RegExp(`^/array/${POSTHOG_TOKEN}/array\\.js$`)

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ProxyDeps = {
  fetchImpl?: FetchLike
  limiter?: RateLimiter
}

let defaultLimiter: RateLimiter | undefined
const getDefaultLimiter = () =>
  (defaultLimiter ??= createRateLimiter({ name: 'analytics-relay', limit: REQUESTS_PER_MINUTE, windowMs: 60_000 }))

/**
 * The visitor's address. Railway's edge appends the address it saw to X-Forwarded-For, so the LAST entry is the one
 * the platform vouches for; earlier entries are whatever the client sent and are ignored. `x-real-ip` is not read: a
 * client can send its own. Outside Railway (local development) there may be no header, and the address is "unknown".
 */
export function clientAddress(request: Request): string {
  const entries = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries[entries.length - 1] ?? 'unknown'
}

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } })
}

/** Only this site's own origin is answered with CORS headers. */
function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  if (origin === `https://${SITE_HOST}` || origin === new URL(request.url).origin) return origin
  return null
}

/** The api_key a JSON capture body names (or each event's, for a batch), when the body is plain JSON; a different key is refused. */
function carriesOtherKey(text: string, headers: Headers): boolean {
  if (headers.get('content-encoding')) return false // compressed: PostHog reads it, not us
  try {
    const parsed: unknown = JSON.parse(text)
    const events = Array.isArray(parsed) ? parsed : [parsed]
    return events.some((event) => {
      const key = (event as { api_key?: unknown } | null)?.api_key
      return typeof key === 'string' && key !== POSTHOG_TOKEN
    })
  } catch {
    return false
  }
}

export async function proxyPosthog(request: Request, deps: ProxyDeps | FetchLike = {}): Promise<Response> {
  const { fetchImpl = fetch, limiter = getDefaultLimiter() }: ProxyDeps = typeof deps === 'function' ? { fetchImpl: deps } : deps
  const url = new URL(request.url)
  if (url.pathname !== PROXY_PREFIX && !url.pathname.startsWith(`${PROXY_PREFIX}/`)) return plain(404)
  const method = request.method.toUpperCase()
  const origin = allowedOrigin(request)

  if (method === 'OPTIONS') {
    if (!origin) return plain(403)
    return plain(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': ALLOWED_HEADERS_LIST,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    })
  }

  const path = url.pathname.slice(PROXY_PREFIX.length) || '/'
  const isConfig = config.test(path)
  const isAsset = isConfig || ASSET_PATH.test(path) || ARRAY_JS.test(path)
  const isApi = API_PATHS.has(path)
  // Anything the tracker does not call is not forwarded.
  if (!isAsset && !isApi) return plain(404)
  if (isAsset && method !== 'GET' && method !== 'HEAD') return plain(405, { Allow: 'GET, HEAD' })
  if (isApi && method !== 'POST') return plain(405, { Allow: 'POST' })

  let rate
  try {
    rate = await limiter.checkAddress(clientAddress(request))
  } catch {
    return plain(503)
  }
  if (!rate.ok) return plain(429, { 'Retry-After': String(rate.retryAfterSeconds) })

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
    if (isConfig && origin) headers.set('origin', origin)
  } else {
    const authorization = request.headers.get('authorization') ?? ''
    if (authorization) {
      // Only this app's own project key; any other credential is refused rather than silently dropped.
      if (authorization !== `Bearer ${POSTHOG_TOKEN}`) return plain(403)
      headers.set('authorization', authorization)
    }
    const ip = clientAddress(request)
    if (ip !== 'unknown') headers.set('x-forwarded-for', ip)
    if (method === 'POST') {
      // Stops reading at the cap even when the request states no length (413).
      const read = await readBodyBytes(request, MAX_BODY_BYTES)
      if ('response' in read) return plain(413)
      if (carriesOtherKey(read.bytes.toString('utf8'), headers)) return plain(403)
      body = read.bytes.buffer.slice(read.bytes.byteOffset, read.bytes.byteOffset + read.bytes.byteLength) as ArrayBuffer
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
  if (isAsset) out.set('Access-Control-Allow-Origin', isConfig ? (origin ?? '*') : '*')
  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out })
}
