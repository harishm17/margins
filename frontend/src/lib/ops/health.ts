/**
 * What the health routes say, and to whom.
 *
 * `/api/health/ready` is public and answers only pass or fail, for the external uptime check: the database answers,
 * the AI service is ready (its own `/health` waits for its migration), and the AI service's watchdog ran recently.
 * The watchdog is what sends every other alert, so a watchdog that stopped is itself a failure.
 *
 * `/api/health/runtime` gives the detail (configuration checks and their messages) only to a signed-in user or a
 * caller holding AI_INTERNAL_TOKEN; everyone else gets pass or fail.
 */
import { createHash, timingSafeEqual } from 'crypto'

/** The watchdog runs every 5 minutes; three missed runs mean it has stopped. */
export const WATCHDOG_STALE_MS = 15 * 60 * 1000

export type ReadinessChecks = {
  /** Resolves when the database answers a query. */
  database(): Promise<void>
  /** True when the AI service's /health answers 200. */
  aiService(): Promise<boolean>
  /** `ops_state.watchdog_last_run` (an ISO time), or null when the watchdog never ran. */
  watchdogLastRun(): Promise<string | null>
}

export type Readiness = { ready: boolean; failed: string[] }

export async function readiness(checks: ReadinessChecks, now: Date = new Date()): Promise<Readiness> {
  const failed: string[] = []
  try {
    await checks.database()
  } catch {
    failed.push('database')
  }
  try {
    if (!(await checks.aiService())) failed.push('ai_service')
  } catch {
    failed.push('ai_service')
  }
  if (!failed.includes('database')) {
    try {
      const lastRun = await checks.watchdogLastRun()
      const at = lastRun ? Date.parse(lastRun) : NaN
      if (Number.isNaN(at) || now.getTime() - at > WATCHDOG_STALE_MS) failed.push('watchdog')
    } catch {
      failed.push('watchdog')
    }
  }
  return { ready: failed.length === 0, failed }
}

/** The public body: never more than pass or fail. */
export function publicHealthBody(ok: boolean) {
  return { status: ok ? 'ok' : 'unavailable' } as const
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** True when `headers` carry AI_INTERNAL_TOKEN (as `x-ai-internal-token` or `Authorization: Bearer`). */
export function holdsInternalToken(headers: Headers, expected: string | undefined = process.env.AI_INTERNAL_TOKEN) {
  if (!expected) return false
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const provided = headers.get('x-ai-internal-token') ?? bearer
  // Compare digests: equal length, so the comparison takes the same time whatever the input.
  return provided ? timingSafeEqual(digest(provided), digest(expected)) : false
}
