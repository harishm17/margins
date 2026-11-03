/**
 * Start a review session or a concept drill (spec §7.4).
 * POST /api/projects/[projectId]/review-sessions
 *   {}                      today's review: up to 12 items from the due concepts of the course
 *   { topicId }             the same, filtered to that topic's due concepts plus up to two others
 *   { conceptId }           a drill on one concept (and its weakest prerequisite)
 * -> { status: 'created', sessionId } | { status: 'empty' }. Concepts with no fresh item are written
 * by a job the session follows; poll GET /api/review-sessions/[sessionId].
 *
 * GET /api/projects/[projectId]/review-sessions?active=1 -> { session: { sessionId, answered, total, kind, short, topicId } | null }:
 * today's newest unfinished review session, for "Resume today's review (5 of 12)" (spec 18.7).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { activeSession, startSession } from '@/lib/learning/review-session'
import { aiRefusal } from '@/lib/api/ai-preflight'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError, apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError, zodDetails } from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

// Starting a session can send a job that writes new items (a model call), so a script cannot start them without end.
const startLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 })

const bodySchema = z
  .object({
    topicId: z.string().min(1).max(64).optional(),
    conceptId: z.string().min(1).max(64).optional(),
  })
  .refine((body) => !(body.topicId && body.conceptId), { message: 'Give a topic or a concept, not both' })

export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: auth.user.id }, select: { id: true } })
    if (!project) return apiNotFound('Course not found')

    const limit = startLimiter.check(auth.user.id)
    if (!limit.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'You are asking quickly. Wait a moment, then try again.', { code: 'RATE_LIMITED', retryable: true }, 429)
      response.headers.set('Retry-After', String(limit.retryAfterSeconds))
      return response
    }

    const result = await startSession({
      userId: auth.user.id,
      projectId,
      kind: parsed.data.conceptId ? 'drill' : 'review',
      topicId: parsed.data.topicId,
      conceptId: parsed.data.conceptId,
      timeZone: await getTimeZone(),
    })
    if (result.status === 'not_found') return apiNotFound('Topic or concept not found')
    if (result.status === 'blocked') return aiRefusal(result.code)
    if (result.status === 'empty') return NextResponse.json({ status: 'empty', legacyReview: result.legacyReview })
    return NextResponse.json({ status: 'created', sessionId: result.sessionId }, { status: 201 })
  } catch (error) {
    console.error('Start review session error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to start the review')
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    if (new URL(request.url).searchParams.get('active') !== '1') return apiInvalidInput('Ask for ?active=1')
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: auth.user.id }, select: { id: true } })
    if (!project) return apiNotFound('Course not found')
    return NextResponse.json({ session: await activeSession(auth.user.id, projectId, await getTimeZone()) })
  } catch (error) {
    console.error('Active review session error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to look for a review in progress')
  }
}
