/**
 * GET /api/ai-status: whether AI features can be used now, for the banner and the AI buttons.
 * Public (the marketing and sign-in pages show the banner too); a signed-in student also gets
 * their allowance, as a share of the day's limit, never in dollars. `?fresh=1` (skip the short
 * cache) is for signed-in users only and throttled: see src/server/ai-status-request.
 */
import { createAiStatusHandler, createFreshLimiter } from '@/server/ai-status-request'
import { getAiStatus } from '@/server/ai-status'
import { getSessionUser } from '@/server/session'

export const dynamic = 'force-dynamic'

const handle = createAiStatusHandler({
  getUser: getSessionUser,
  getStatus: (userId, options) => getAiStatus(userId, options),
  freshLimiter: createFreshLimiter(),
})

export async function GET(request: Request) {
  return handle(request)
}
