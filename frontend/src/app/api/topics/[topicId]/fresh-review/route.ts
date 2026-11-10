/**
 * "Fresh review": a new 6-question quiz set for a topic that is due, written by the regeneration
 * path (cached excerpts). Difficulty follows the topic's support band (spec 18.6: easy, medium or hard). The focus is the concepts of the
 * questions missed lately, and 1-2 questions come from the weakest prerequisite topic when there is one.
 * POST /api/topics/[topicId]/fresh-review -> the same answer as regenerate-content (a job id to follow).
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { ownedTopic } from '@/server/owned'
import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { startRegeneration } from '@/lib/jobs/regenerate'
import { freshReviewPreferences, planFreshReview } from '@/lib/learning/review-server'
import { onDemandQuizPreferences, topicBandOf } from '@/lib/learning/quiz-band'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { topicId } = await params
    const topic = await ownedTopic(session.user.id, topicId)
    if (!topic) return apiNotFound('Topic not found')

    const plan = await planFreshReview(session.user.id, topic)
    const band = await topicBandOf(session.user.id, topic.id)
    return await startRegeneration({
      userId: session.user.id,
      topic,
      contentType: 'topic_quiz',
      preferences: onDemandQuizPreferences(freshReviewPreferences(plan), band),
    })
  } catch (error) {
    logServerError('Fresh review error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to start the fresh review')
  }
}
