/**
 * "Retry what you missed": a quiz set of the questions the student got wrong in their last two
 * attempts on the topic. No model call: the questions are copied from the sets they came from.
 * POST /api/topics/[topicId]/retry-quiz -> { quizSetId, questionCount }; 404 when nothing was missed.
 * The set is taken and graded like any other (POST /quiz-attempts with its quizSetId).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRetrySet } from '@/lib/learning/review-server'
import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const { topicId } = await params
    const topic = await prisma.topic.findFirst({
      where: { id: topicId, project: { userId: session.user.id } },
      select: { id: true },
    })
    if (!topic) return apiNotFound('Topic not found')

    // A quiz that waited for the AI and was graded since counts: its misses are what to retry.
    await applyPendingQuizResults(session.user.id, { topicId })
    const set = await createRetrySet(session.user.id, topicId)
    if (!set) return apiNotFound('There are no missed questions to retry')
    return NextResponse.json(set)
  } catch (error) {
    console.error('Retry quiz error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to prepare the retry quiz')
  }
}
