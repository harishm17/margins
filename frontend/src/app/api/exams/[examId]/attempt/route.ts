/**
 * The student's attempt at an exam.
 *
 * GET  /api/exams/[examId]/attempt  the attempt in progress (answers and remaining time), if any
 * POST /api/exams/[examId]/attempt  start the attempt; the server records the start time
 * PUT  /api/exams/[examId]/attempt  autosave { answers }; refused once the deadline and grace pass
 *
 * Submitting is POST /api/exams/[examId]/submit.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import {
  apiError,
  ApiErrorCode,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import {
  ATTEMPT_IN_PROGRESS,
  countQuestions,
  finalizeAttempt,
  findExamForUser,
  findInProgressAttempt,
  loadAttemptState,
  startAttempt,
  toAttemptView,
} from '@/lib/exams/attempts'
import { EXAM_ANSWERS_MAX_BYTES, acceptsAnswers, examAnswersSchema, remainingSeconds, sanitizeAnswers } from '@/lib/exams/attempt-timing'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ examId: string }> }

const handleError = (error: unknown, label: string) => {
  console.error(label, error)
  if (isUnauthorizedError(error)) return apiUnauthorized()
  return apiInternal('Internal server error')
}

// Kept for API clients; the UI reads this through server queries.
export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const session = await requireAuth()
    const { examId } = await params
    const exam = await findExamForUser(session.user.id, examId)
    if (!exam) return apiNotFound('Exam not found')

    const state = await loadAttemptState(session.user.id, exam)
    if (state.kind === 'active') return NextResponse.json({ attempt: state.attempt })
    if (state.kind === 'finalized') {
      return NextResponse.json({
        attempt: null,
        submitted: { submissionId: state.submissionId, jobId: state.jobId },
      })
    }
    return NextResponse.json({ attempt: null })
  } catch (error) {
    return handleError(error, 'Error loading exam attempt:')
  }
}

export async function POST(_request: NextRequest, { params }: Context) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { examId } = await params
    const exam = await findExamForUser(session.user.id, examId)
    if (!exam) return apiNotFound('Exam not found')

    // An attempt that ran out of time while the student was away is submitted first, so
    // starting again gives a fresh attempt instead of reopening a finished one.
    await loadAttemptState(session.user.id, exam)

    const attempt = await startAttempt(session.user.id, exam)
    return NextResponse.json({ attempt: toAttemptView(attempt, new Date()) })
  } catch (error) {
    return handleError(error, 'Error starting exam attempt:')
  }
}

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { examId } = await params
    const exam = await findExamForUser(session.user.id, examId)
    if (!exam) return apiNotFound('Exam not found')

    const body = await readJson(request, examAnswersSchema, { maxBytes: EXAM_ANSWERS_MAX_BYTES })
    if (!body.ok) return body.response
    const answers = sanitizeAnswers(body.data.answers, await countQuestions(examId))
    if (!answers) return apiInvalidInput('answers must be an object')

    const attempt = await findInProgressAttempt(session.user.id, examId)
    if (!attempt || !attempt.deadlineAt) {
      return apiError(
        ApiErrorCode.CONFLICT,
        'This exam is not in progress. Open the exam page to start or review it.',
        { code: 'ATTEMPT_CLOSED' },
        409
      )
    }

    const now = new Date()
    if (!acceptsAnswers(attempt.deadlineAt, now)) {
      // Too late to save. Submit what was saved in time so the attempt is not left open.
      const result = await finalizeAttempt(session.user.id, exam, attempt, null, now)
      return NextResponse.json(
        {
          error: {
            code: ApiErrorCode.CONFLICT,
            message: 'Time is up. Your saved answers were submitted.',
            details: { code: 'ATTEMPT_EXPIRED', submissionId: result.submissionId },
          },
        },
        { status: 409 }
      )
    }

    // Only an attempt still in progress may change, even if it is finalised right now.
    const saved = await prisma.examSubmission.updateMany({
      where: { id: attempt.id, userId: session.user.id, status: ATTEMPT_IN_PROGRESS },
      data: { answers, answersSavedAt: now },
    })
    if (saved.count === 0) {
      return apiError(
        ApiErrorCode.CONFLICT,
        'This exam was already submitted.',
        { code: 'ATTEMPT_CLOSED' },
        409
      )
    }

    return NextResponse.json({
      savedAt: now.toISOString(),
      remainingSeconds: remainingSeconds(attempt.deadlineAt, now),
    })
  } catch (error) {
    return handleError(error, 'Error saving exam answers:')
  }
}
