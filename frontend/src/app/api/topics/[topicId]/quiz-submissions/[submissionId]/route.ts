/**
 * GET /api/topics/[topicId]/quiz-submissions/[submissionId]
 *
 * A quiz that waited for the AI: { status: 'pending' } until its grading is stored, then the same
 * result a quiz graded at once returns ({ status: 'graded', score, review, outcome, ... }). The first
 * look at a graded quiz turns it into the attempt and applies it to mastery and the review date.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import { applyQuizSubmission } from '@/lib/learning/quiz-submissions'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ topicId: string; submissionId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId, submissionId } = await params

    const submission = await prisma.quizSubmission.findFirst({
      where: { id: submissionId, topicId, userId: session.user.id },
      select: { id: true },
    })
    if (!submission) return apiNotFound('Quiz submission not found')

    const applied = await applyQuizSubmission(session.user.id, submission.id)
    if (!applied) return NextResponse.json({ status: 'pending' })

    return NextResponse.json({
      status: 'graded',
      attempt: { id: applied.attemptId },
      bestScore: applied.bestScore,
      score: applied.score,
      earnedPoints: applied.earnedPoints,
      totalPoints: applied.totalPoints,
      review: applied.review,
      answers: applied.answers,
      outcome: applied.outcome,
    })
  } catch (error) {
    console.error('Quiz submission status error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the quiz result')
  }
}
