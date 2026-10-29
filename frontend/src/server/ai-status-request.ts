/**
 * The GET /api/ai-status handler, with its collaborators passed in so a test can drive it.
 *
 * `?fresh=1` skips the 10-second status cache. The page sends it once right after a request was
 * refused because AI is unavailable (lib/ai/status-tracker), so it is honoured only for a
 * signed-in user, and at most once a second for each user. Everyone else, and a repeat inside that
 * second, gets the cached answer (which the last fresh read just refilled). Otherwise a script
 * looping on `?fresh=1` would make every request reach the AI service and the database.
 */
import { NextResponse } from 'next/server'
import { createRateLimiter, type RateLimiter } from '@/lib/api/rate-limit'
import { toClientStatus } from '@/lib/ai/status'
import type { AiStatusDetails } from '@/lib/ai/status'

/** One real fresh read per user per second, in memory in this instance like the other limiters. */
export const FRESH_WINDOW_MS = 1000

export function createFreshLimiter(): RateLimiter {
  return createRateLimiter({ limit: 1, windowMs: FRESH_WINDOW_MS })
}

type Deps = {
  getUser: () => Promise<{ id: string } | null>
  getStatus: (userId: string | null, options: { fresh: boolean }) => Promise<AiStatusDetails>
  freshLimiter: RateLimiter
}

export function createAiStatusHandler({ getUser, getStatus, freshLimiter }: Deps) {
  return async function handle(request: Request): Promise<Response> {
    const user = await getUser().catch(() => null)
    const asked = new URL(request.url).searchParams.get('fresh') === '1'
    const fresh = asked && user !== null && freshLimiter.check(user.id).ok
    const status = toClientStatus(await getStatus(user?.id ?? null, { fresh }))
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } })
  }
}
