/**
 * API route for regenerating content (creates fresh variations)
 * POST /api/topics/[topicId]/regenerate-content
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { quotaErrorResponse } from '@/lib/api/quota'
import { readJson } from '@/lib/api/read-json'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { regenerateContentSchema, startRegeneration } from '@/lib/jobs/regenerate'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { topicId } = await params

    // Verify topic ownership through project
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
      select: { id: true, projectId: true },
    })

    if (!topic) {
      return apiNotFound('Topic not found')
    }

    const validation = await readJson(request, regenerateContentSchema)
    if (!validation.ok) return validation.response

    const { contentType, preferences } = validation.data
    return await startRegeneration({ userId: session.user.id, topic, contentType, preferences })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    logServerError('Content regeneration error', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to start content regeneration')
  }
}
