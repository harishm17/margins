/**
 * Start a review session or a concept drill (spec §7.4).
 * POST /api/projects/[projectId]/review-sessions
 *   {}                      today's review: up to 12 items from the due concepts of the course
 *   { topicId }             the same, filtered to that topic's due concepts plus up to two others
 *   { conceptId }           a drill on one concept (and its weakest prerequisite)
 *   { examSubmissionId }    new questions on the concepts the missed questions of that graded mock-exam attempt were about
 *                           (their topics' concepts when the questions name none), one per concept, no closing retests
 * -> { status: 'created', sessionId } | { status: 'empty' }. Concepts with no fresh item are written
 * by a job the session follows; poll GET /api/review-sessions/[sessionId].
 *
 * GET /api/projects/[projectId]/review-sessions?active=1 -> { session: { sessionId, answered, total, kind, short, topicId } | null }:
 * today's newest unfinished review session, for "Resume today's review (5 of 12)" (spec 18.7).
 */

import { readJson } from '@/lib/api/read-json'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { activeSession, startSession } from '@/lib/learning/review-session'
import { examPractice } from '@/lib/learning/exam-practice'
import { ATTEMPT_SUBMITTED } from '@/lib/exams/attempts'
import { aiRefusal } from '@/lib/api/ai-preflight'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError, apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError, zodDetails } from '@/lib/api/errors'
import { getTimeZone } from '@/server/timezone'

export const dynamic = 'force-dynamic'

// Starting a session can send a job that writes new items (a model call), so a script cannot start them without end.
const startLimiter = createRateLimiter({ name: 'review-start', limit: 20, windowMs: 60_000 })

const bodySchema = z
  .object({
    topicId: z.string().min(1).max(64).optional(),
    conceptId: z.string().min(1).max(64).optional(),
    // Practice on what this graded mock-exam attempt's missed questions were about.
    examSubmissionId: z.string().min(1).max(64).optional(),
  })
  .refine((body) => [body.topicId, body.conceptId, body.examSubmissionId].filter(Boolean).length <= 1, { message: 'Give a topic, a concept or an exam, not several' })

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    const parsed = await readJson(request, bodySchema.default({}))
    if (!parsed.ok) return parsed.response

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: auth.user.id }, select: { id: true } })
    if (!project) return apiNotFound('Course not found')

    const limit = await startLimiter.check(auth.user.id)
    if (!limit.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'You are asking quickly. Wait a moment, then try again.', { code: 'RATE_LIMITED', retryable: true }, 429)
      response.headers.set('Retry-After', String(limit.retryAfterSeconds))
      return response
    }

    let fromExam: Partial<Parameters<typeof startSession>[0]> = {}
    if (parsed.data.examSubmissionId) {
      // The student's own graded attempt in this course: what its missed questions were about, as new questions.
      const submission = await prisma.examSubmission.findFirst({
        where: { id: parsed.data.examSubmissionId, userId: auth.user.id, status: ATTEMPT_SUBMITTED, sampleExam: { projectId } },
        select: { aiGrading: true, sampleExam: { select: { questions: true } } },
      })
      if (!submission) return apiNotFound('Exam attempt not found')
      const practice = await examPractice(projectId, submission.sampleExam.questions, submission.aiGrading)
      if (!practice) return NextResponse.json({ status: 'empty', legacyReview: false })
      fromExam = {
        fromExam: practice.kind === 'concepts' ? { conceptIds: practice.conceptIds } : {},
        topicIds: practice.kind === 'topics' ? practice.topicIds : undefined,
        includeNotDue: true,
        limit: practice.count,
        // The exam was the test; the session asks each idea once, so its question count is the one on the button.
        retestCap: 0,
      }
    }

    const result = await startSession({
      userId: auth.user.id,
      projectId,
      kind: parsed.data.conceptId ? 'drill' : 'review',
      topicId: parsed.data.topicId,
      conceptId: parsed.data.conceptId,
      timeZone: await getTimeZone(),
      ...fromExam,
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

export const POST = withClientSignal(handlePOST)
