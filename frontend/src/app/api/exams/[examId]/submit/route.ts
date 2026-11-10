/**
 * POST /api/exams/[examId]/submit
 *
 * Finalises the attempt in progress and starts grading. The body may carry the final
 * { answers }; they are used while time remains. Without a body, or after the deadline and
 * grace, the last autosave is what gets graded.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
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
import {
  countQuestions,
  finalizeAttempt,
  findExamForUser,
  findInProgressAttempt,
} from '@/lib/exams/attempts'
import { EXAM_ANSWERS_MAX_BYTES, examAnswersSchema, sanitizeAnswers, type AnswerMap } from '@/lib/exams/attempt-timing'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ examId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
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

    const body = await readJson(req, examAnswersSchema.partial().default({}), { maxBytes: EXAM_ANSWERS_MAX_BYTES })
    if (!body.ok) return body.response
    let submitted: AnswerMap | null = null
    if (body.data.answers !== undefined) {
      submitted = sanitizeAnswers(body.data.answers, await countQuestions(examId))
      if (!submitted) return apiInvalidInput('answers must be an object')
    }

    // The answers are the student's work: a submission is always accepted and stored, whatever
    // the AI status or the allowance. Grading is queued; while the AI cannot run, the grading job
    // waits (ai-service job_runner `wait_for_ai`) and the results page says so.
    const now = new Date()

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
