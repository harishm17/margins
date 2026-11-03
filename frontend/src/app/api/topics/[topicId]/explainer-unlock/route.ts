/**
 * "I'd rather read an explanation now" (spec §5.4, §18.10).
 * POST /api/topics/[topicId]/explainer-unlock
 * Needs the topic to have been read (readAt): 409 READ_FIRST otherwise. Writes explainerUnlockedAt and
 * explainerUnlockReason='asked' once; asking again, or asking for a topic whose explainer is already open
 * (a recall was done, or there is no recall to do), changes nothing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { unlockExplainer } from '@/lib/learning/explainer-server'
import { ApiErrorCode, apiError, apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const result = await unlockExplainer({ userId: auth.user.id, topicId })
    if (result.status === 'not_found') return apiNotFound('Topic not found')
    if (result.status === 'read_first') {
      return apiError(ApiErrorCode.CONFLICT, 'Read this topic first. The explainer opens after you have read it.', { code: 'READ_FIRST', retryable: false }, 409)
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Explainer unlock error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Could not open the explainer')
  }
}
