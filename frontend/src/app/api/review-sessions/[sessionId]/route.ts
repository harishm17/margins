/**
 * A review session or drill as the student sees it: its items without answer keys, the results of
 * the ones answered, and its status. Each read advances the session (finished jobs are picked up,
 * closing retests are added), so the browser polls this while the status is "preparing".
 * GET /api/review-sessions/[sessionId]
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { sessionView } from '@/lib/learning/review-session'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireAuth()
    const { sessionId } = await params
    const view = await sessionView(auth.user.id, sessionId, await getTimeZone())
    if (!view) return apiNotFound('Session not found')
    return NextResponse.json(view)
  } catch (error) {
    console.error('Review session error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the review')
  }
}
