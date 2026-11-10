/**
 * "Skip for now": the next question of a review session or drill goes to the end, with no evidence.
 * POST /api/review-sessions/[sessionId]/skip { index } -> the session
 */

import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { skipItem } from '@/lib/learning/review-session'
import { apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError, zodDetails } from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ index: z.number().int().min(0).max(60) })

export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireAuth()
    const { sessionId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const result = await skipItem({ userId: auth.user.id, sessionId, index: parsed.data.index, timeZone: await getTimeZone() })
    if (result.status === 'not_found') return apiNotFound('Session not found')
    if (result.status === 'invalid') return apiInvalidInput(result.message)
    return NextResponse.json(result.view)
  } catch (error) {
    console.error('Review skip error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to skip the question')
  }
}
