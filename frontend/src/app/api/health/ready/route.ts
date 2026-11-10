import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { publicHealthBody, readiness } from '@/lib/ops/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public pass or fail for the external uptime check (lib/ops/health.ts says what it checks). The body never says which
 * check failed; the server log does.
 */
export async function GET() {
  const result = await readiness({
    database: async () => {
      await prisma.$queryRaw`SELECT 1`
    },
    aiService: async () => {
      const url = process.env.AI_SERVICE_URL
      if (!url) return false
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
      return response.ok
    },
    watchdogLastRun: async () =>
      (await prisma.opsState.findUnique({ where: { key: 'watchdog_last_run' } }))?.value ?? null,
  })
  if (!result.ready) console.error(`[HEALTH] Not ready: ${result.failed.join(', ')}`)
  return NextResponse.json(publicHealthBody(result.ready), {
    status: result.ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
