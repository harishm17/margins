/**
 * The 10-minute session (spec 18.8).
 * POST /api/projects/[projectId]/short-session
 *   -> { kind: 'review' | 'mini_quiz', sessionId, href } a short review session was started (href opens it)
 *   -> { kind: 'recall', href }                          one recall card on the plan's current topic
 *   -> { kind: 'none' }                                  nothing to offer (nothing due, no topic to quiz)
 * What is offered is `shortSessionPlan`: due concepts make a review of at most 6 items with at most 2 closing retests; else a
 * read topic that is not yet recalled offers its recall card (AI up); else a 4-question mini quiz from the current topic's
 * concepts, with no closing retests. A short session is a review session (`ItemSession kind='review'`, `results.short`), never
 * a quiz attempt.
 */

import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { startSession } from '@/lib/learning/review-session'
import { loadShortSessionState } from '@/lib/learning/short-session-server'
import { shortSessionPlan } from '@/lib/learning/short-session'
import { aiRefusal } from '@/lib/api/ai-preflight'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError, apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

const startLimiter = createRateLimiter({ name: 'short-session-start', limit: 20, windowMs: 60_000 })

async function handlePOST(_request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: auth.user.id }, select: { id: true } })
    if (!project) return apiNotFound('Course not found')

    const limit = await startLimiter.check(auth.user.id)
    if (!limit.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'You are asking quickly. Wait a moment, then try again.', { code: 'RATE_LIMITED', retryable: true }, 429)
      response.headers.set('Retry-After', String(limit.retryAfterSeconds))
      return response
    }

    const timeZone = await getTimeZone()
    const state = await loadShortSessionState(auth.user.id, projectId, timeZone)
    const plan = state ? shortSessionPlan(state) : null
    if (!state || !plan) return NextResponse.json({ kind: 'none' })
    if (plan.kind === 'recall' && plan.href) return NextResponse.json({ kind: 'recall', href: plan.href })

    const started = await startSession(
      plan.kind === 'review'
        ? { userId: auth.user.id, projectId, kind: 'review', limit: plan.limit, retestCap: plan.retestCap, short: true, timeZone }
        : { userId: auth.user.id, projectId, kind: 'review', limit: plan.limit, includeNotDue: true, retestCap: 0, topicIds: [state.currentTopic?.id ?? ''], short: true, timeZone }
    )
    if (started.status === 'blocked') return aiRefusal(started.code)
    if (started.status === 'not_found') return apiNotFound('Topic not found')
    if (started.status === 'empty') return NextResponse.json({ kind: 'none' })
    return NextResponse.json(
      { kind: plan.kind, sessionId: started.sessionId, href: `/courses/${projectId}/review/session?session=${started.sessionId}` },
      { status: 201 }
    )
  } catch (error) {
    console.error('Start short session error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to start the short session')
  }
}

export const POST = withClientSignal(handlePOST)
