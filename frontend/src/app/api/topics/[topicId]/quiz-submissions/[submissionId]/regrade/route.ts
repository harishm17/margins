/**
 * POST /api/topics/[topicId]/quiz-submissions/[submissionId]/regrade
 *
 * Grades a stored quiz again, after its grading did not finish (it waited for the AI for the whole
 * limit, or failed). A grading job that is waiting or running is returned instead of starting another.
 * Not refused while the AI is unavailable: the job waits for it, like the first one.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { apiInternal, apiNotFound, apiUnauthorized, apiUpstream, isUnauthorizedError } from '@/lib/api/errors'
import { startQuizGrading } from '@/lib/learning/quiz-submissions'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ topicId: string; submissionId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId, submissionId } = await params

    const submission = await prisma.quizSubmission.findFirst({
      where: { id: submissionId, topicId, userId: session.user.id, status: 'pending' },
      select: { id: true, topic: { select: { id: true, projectId: true } } },
    })
    if (!submission) return apiNotFound('Quiz submission not found')

    const grading = await startQuizGrading(session.user.id, submission.topic, submission.id)
    if (!grading.started) return apiUpstream('Grading could not start. Please try again.')

    return NextResponse.json({ submissionId: submission.id, jobId: grading.jobId, status: 'queued' })
  } catch (error) {
    console.error('Error regrading quiz:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Internal server error')
  }
}
