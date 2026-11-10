/**
 * GET /api/projects/[projectId]/generation-failures
 *
 * Content blocks (notes, examples, quiz) whose latest generation job failed and that still
 * do not exist, with the topic and a message the student can act on. Each one can be retried
 * with POST /api/topics/[topicId]/generate-content.
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { pickGenerationFailures } from '@/lib/jobs/failure-message'

export const dynamic = 'force-dynamic'

// Enough history to find the latest job of every topic and content type in a large project.
const RECENT_JOB_LIMIT = 600

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.user.id },
      select: { id: true },
    })
    if (!project) return apiNotFound('Project not found')

    const [jobs, topics] = await Promise.all([
      prisma.processingJob.findMany({
        where: { projectId, jobType: 'generate_content', targetKey: { not: null } },
        select: { id: true, targetKey: true, status: true, errorCode: true, errorMessage: true },
        orderBy: { createdAt: 'desc' },
        take: RECENT_JOB_LIMIT,
      }),
      prisma.topic.findMany({
        where: { projectId },
        select: { id: true, name: true, content: { select: { contentType: true } } },
      }),
    ])

    const topicsById = new Map(topics.map((topic) => [topic.id, topic]))
    const has = new Map(
      topics.map((topic) => [topic.id, new Set(topic.content.map((item) => item.contentType))])
    )

    const failures = pickGenerationFailures(jobs, (topicId, contentType) =>
      has.get(topicId)?.has(contentType) ?? false
    )
      // A deleted or merged topic has nothing left to retry.
      .filter((failure) => topicsById.has(failure.topicId))
      .map((failure) => ({ ...failure, topicName: topicsById.get(failure.topicId)!.name }))

    return NextResponse.json({ failures })
  } catch (error) {
    logServerError('Generation failures error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load generation failures')
  }
}
