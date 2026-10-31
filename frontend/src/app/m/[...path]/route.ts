import { proxyPosthog } from '@/lib/analytics/proxy'

/** Same-origin reverse proxy to PostHog: see lib/analytics/proxy.ts. */
export const dynamic = 'force-dynamic'

export const GET = (request: Request) => proxyPosthog(request)
export const HEAD = GET
export const POST = GET
export const OPTIONS = GET
