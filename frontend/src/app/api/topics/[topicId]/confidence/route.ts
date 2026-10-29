import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import {
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
  zodDetails,
} from '@/lib/api/errors'
import { adjustReviewForConfidence, computeTopicMastery, isConfidenceFeedback } from '@/lib/learning/mastery'

const confidenceSchema = z.object({
  source: z.enum(['quiz', 'voice', 'exam']),
  value: z.number().int().min(1).max(5),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const auth = await requireAuth()
    await applyPendingQuizResults(auth.user.id)
    const { topicId } = await params
    const body = await request.json()
    const parsed = confidenceSchema.safeParse(body)
    if (!parsed.success) {
      return apiInvalidInput('Invalid input', zodDetails(parsed.error))
    }

    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: { userId: auth.user.id },
      },
      select: {
        id: true,
        projectId: true,
      },
    })

    if (!topic) {
      return apiNotFound('Topic not found')
    }

    // Confidence is a rating, not a result. It is attached to the student's latest real
    // signal for this source, so it never adds a score of its own, and it never counts
    // as practice (no streak change).
    const recentSignals = await prisma.learningSignal.findMany({
      where: {
        userId: auth.user.id,
        projectId: topic.projectId,
        topicId: topic.id,
        source: parsed.data.source,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, metadata: true },
    })
    // Skip rows an older version of this route wrote: they hold a copy of a past score.
    const latestSignal = recentSignals.find((signal) => !isConfidenceFeedback(signal.metadata))
    if (latestSignal) {
      await prisma.learningSignal.update({
        where: { id: latestSignal.id },
        data: { confidence: parsed.data.value },
      })
    }

    const mastery = await computeTopicMastery(auth.user.id, topic.projectId, topic.id)
    const schedule = await adjustReviewForConfidence({
      userId: auth.user.id,
      topicId: topic.id,
      mastery: mastery.mastery,
      confidence: parsed.data.value,
    })

    return NextResponse.json({
      success: true,
      confidence: parsed.data.value,
      mastery: mastery.mastery,
      nextReviewAt: schedule?.dueAt ?? null,
    })
  } catch (error) {
    console.error('Confidence save error:', error)
    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }
    return apiInternal('Failed to save confidence')
  }
}
