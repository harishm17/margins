/**
 * Answer the next question of a review session or drill.
 * POST /api/review-sessions/[sessionId]/answer { index, answer: string | { answer, confidence?, thinking?, idk? } }
 * Grades the answer, writes level-0 evidence (source review or drill, the session id as session key) and
 * answers with the session, now holding the result and the answer key for this item. The session waits
 * for the student: nothing moves on until the next question is asked for.
 */

import { logServerError } from '@/lib/ops/log'
import { readJson } from '@/lib/api/read-json'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { GradingRejectedError, GradingUnavailableError } from '@/lib/ai-service/grading'
import { answerItem } from '@/lib/learning/review-session'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  index: z.number().int().min(0).max(60),
  answer: z.union([
    z.string().max(5000),
    z.object({
      answer: z.string().max(5000),
      confidence: z.number().optional(),
      confidenceLevel: z.enum(['guess', 'unsure', 'fairly', 'certain']).optional(),
      thinking: z.string().max(4000).optional(),
      // The "I don't know" button (spec 18.3): a miss with nothing to grade.
      idk: z.boolean().optional(),
    }),
  ]),
})

// A short answer costs a model call.
const answerLimiter = createRateLimiter({ name: 'review-answer', limit: 40, windowMs: 60_000 })

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const auth = await requireAuth()
    const { sessionId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response

    const rate = await answerLimiter.check(auth.user.id)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'Too many answers. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    try {
      const result = await answerItem({
        userId: auth.user.id,
        sessionId,
        index: parsed.data.index,
        answer: parsed.data.answer,
        timeZone: await getTimeZone(),
      })
      if (result.status === 'not_found') return apiNotFound('Session not found')
      if (result.status === 'invalid') return apiInvalidInput(result.message)
      return NextResponse.json(result.view)
    } catch (error) {
      if (error instanceof GradingUnavailableError) {
        return apiError(ApiErrorCode.UPSTREAM_ERROR, 'This answer could not be graded right now. Your answer is still here: try again in a moment.', { code: error.code }, 503)
      }
      if (error instanceof GradingRejectedError) {
        return apiError(ApiErrorCode.UPSTREAM_ERROR, 'This question could not be graded. Try again.', undefined, 502)
      }
      throw error
    }
  } catch (error) {
    logServerError('Review answer error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save the answer')
  }
}

export const POST = withClientSignal(handlePOST)
