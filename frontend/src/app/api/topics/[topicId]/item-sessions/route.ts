/**
 * The warm-up before reading (spec §5.1). An item session of kind warmup, never a quiz attempt.
 * GET   /api/topics/[topicId]/item-sessions?kind=warmup - where the warm-up stands.
 * POST  /api/topics/[topicId]/item-sessions { kind: 'warmup' } - starts it (or picks the open one up),
 *   snapshotting the topic's warm-up bank; the browser gets the first question without its key.
 * PATCH /api/topics/[topicId]/item-sessions { sessionId, index, answer } - submits one answer: it is graded,
 *   its warm-up evidence is written, and the next question comes back, or the finished warm-up (the keys,
 *   "You'll find this on p. N", the test-out offer, how many passages are marked Focus here) after the last.
 */

import { logServerError } from '@/lib/ops/log'
import { readJson } from '@/lib/api/read-json'
import { ownedTopic } from '@/server/owned'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter, enforceMutationLimit } from '@/lib/api/rate-limit'
import { GradingRejectedError, GradingUnavailableError } from '@/lib/ai-service/grading'
import { answerWarmup, loadWarmupState, startWarmup, type WarmupState } from '@/lib/learning/warmup-session'
import { withFocusCount } from '@/lib/reader/focus'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { studentTimeZone } from '@/lib/learning/student-time-zone'

export const dynamic = 'force-dynamic'

const startSchema = z.object({ kind: z.literal('warmup') })

const answerSchema = z.object({
  sessionId: z.string().min(1).max(100),
  index: z.number().int().min(0).max(60),
  answer: z.union([
    z.string().max(5000),
    z.object({ answer: z.string().max(5000), confidence: z.number().optional(), confidenceLevel: z.enum(['guess', 'unsure', 'fairly', 'certain']).optional() }),
  ]),
})

// A choice answer is graded by rule, but each one writes evidence.
const answerLimiter = createRateLimiter({ name: 'item-answer', limit: 40, windowMs: 60_000 })

export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    if (new URL(request.url).searchParams.get('kind') !== 'warmup') return apiInvalidInput('kind must be warmup')
    const state = await startable(auth.user.id, topicId)
    if (!state) return apiNotFound('Topic not found')
    return NextResponse.json(await withFocusCount(auth.user.id, topicId, state))
  } catch (error) {
    logServerError('Warm-up state error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the warm-up')
  }
}

/** The state of a topic the user owns; null when it is not theirs. */
async function startable(userId: string, topicId: string): Promise<WarmupState | null> {
  const topic = await ownedTopic(userId, topicId)
  return topic ? loadWarmupState(userId, topicId) : null
}

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { topicId } = await params
    const parsed = await readJson(request, startSchema)
    if (!parsed.ok) return parsed.response
    const state = await startWarmup({ userId: auth.user.id, topicId })
    if (state.status === 'not_found') return apiNotFound('Topic not found')
    return NextResponse.json(await withFocusCount(auth.user.id, topicId, state))
  } catch (error) {
    logServerError('Warm-up start error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to start the warm-up')
  }
}

async function handlePATCH(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const parsed = await readJson(request, answerSchema)
    if (!parsed.ok) return parsed.response

    const rate = await answerLimiter.check(auth.user.id)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'Too many answers. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    try {
      const result = await answerWarmup({
        userId: auth.user.id,
        topicId,
        sessionId: parsed.data.sessionId,
        index: parsed.data.index,
        answer: parsed.data.answer,
        timeZone: await studentTimeZone(),
      })
      if (result.status === 'not_found') return apiNotFound('Warm-up not found')
      if (result.status === 'invalid') return apiInvalidInput(result.message)
      return NextResponse.json(await withFocusCount(auth.user.id, topicId, result.state))
    } catch (error) {
      if (error instanceof GradingUnavailableError) {
        return apiError(ApiErrorCode.UPSTREAM_ERROR, 'This answer could not be saved right now. Your answer is still here: try again in a moment.', { code: error.code }, 503)
      }
      if (error instanceof GradingRejectedError) {
        return apiError(ApiErrorCode.UPSTREAM_ERROR, 'This question could not be graded. Try again.', undefined, 502)
      }
      throw error
    }
  } catch (error) {
    logServerError('Warm-up answer error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save the answer')
  }
}

export const POST = withClientSignal(handlePOST)

export const PATCH = withClientSignal(handlePATCH)
