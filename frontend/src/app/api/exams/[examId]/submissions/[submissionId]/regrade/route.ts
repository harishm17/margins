/**
 * POST /api/exams/[examId]/submissions/[submissionId]/regrade
 *
 * Grades the submission again (for answers that could not be graded, or a second look).
 * The earlier results stay in place until the new grading finishes. A grading job that is
 * already running is returned instead of starting another.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  apiUpstream,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { ATTEMPT_SUBMITTED, findExamForUser, startGrading } from '@/lib/exams/attempts'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ examId: string; submissionId: string }> }
) {
  try {
    const session = await requireAuth()
    const { examId, submissionId } = await params

    const exam = await findExamForUser(session.user.id, examId)
    if (!exam) return apiNotFound('Exam not found')

    const submission = await prisma.examSubmission.findFirst({
      where: {
        id: submissionId,
        sampleExamId: examId,
        userId: session.user.id,
        status: ATTEMPT_SUBMITTED,
      },
      select: { id: true },
    })
    if (!submission) return apiNotFound('Submission not found')

    // Not refused while the AI is unavailable: the grading job waits for it, like the first one.
    const grading = await startGrading(session.user.id, exam, submission.id)
    if (!grading.started) return apiUpstream('Grading could not start. Please try again.')

    return NextResponse.json({ submissionId: submission.id, jobId: grading.jobId, status: 'queued' })
  } catch (error) {
    console.error('Error regrading exam:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Internal server error')
  }
}
