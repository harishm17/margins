/**
 * POST /api/exams/[examId]/submit
 *
 * Finalises the attempt in progress and starts grading. The body may carry the final
 * { answers }; they are used while time remains. Without a body, or after the deadline and
 * grace, the last autosave is what gets graded.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import {
  apiError,
  ApiErrorCode,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import {
  countQuestions,
  finalizeAttempt,
  findExamForUser,
  findInProgressAttempt,
} from '@/lib/exams/attempts'
import { isExpired, sanitizeAnswers, type AnswerMap } from '@/lib/exams/attempt-timing'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ examId: string }> }
) {
  try {
    const session = await requireAuth()
    const { examId } = await params

    const exam = await findExamForUser(session.user.id, examId)
    if (!exam) return apiNotFound('Exam not found')

    const attempt = await findInProgressAttempt(session.user.id, examId)
    if (!attempt) {
      return apiError(
        ApiErrorCode.CONFLICT,
        'This exam is not in progress, so there is nothing to submit. Check your exam history.',
        { code: 'ATTEMPT_CLOSED' },
        409
      )
    }

    const body = await req.json().catch(() => ({}))
    let submitted: AnswerMap | null = null
    if (body?.answers !== undefined) {
      submitted = sanitizeAnswers(body.answers, await countQuestions(examId))
      if (!submitted) return apiInvalidInput('answers must be an object')
    }

    // An attempt that is past its time is submitted as saved, whatever the AI service state:
    // that must not be blocked by a health check. Otherwise check first, so a student who
    // still has time can retry the submit instead of losing the attempt. The daily allowance is
    // not checked: the answers are saved and the student grades again after it resets.
    const now = new Date()
    const late = attempt.deadlineAt ? isExpired(attempt.deadlineAt, now) : false
    if (!late) {
      const preflightError = await ensureAiGenerationReady(session.user.id, { checkAllowance: false })
      if (preflightError) return preflightError
    }

    const result = await finalizeAttempt(session.user.id, exam, attempt, submitted, now)

    if (!result.started) {
      // The attempt is saved and submitted; only starting the grader failed.
      return NextResponse.json(
        {
          error: 'Your exam was submitted, but grading could not start. Open the results and choose Grade again.',
          submissionId: result.submissionId,
        },
        { status: 502 }
      )
    }

    return NextResponse.json({
      submissionId: result.submissionId,
      jobId: result.jobId,
      status: 'queued',
      usedSubmittedAnswers: result.usedSubmittedAnswers,
      message: 'Exam submitted and grading started',
      estimatedSeconds: 90,
    })
  } catch (error) {
    console.error('Error submitting exam:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Internal server error')
  }
}
