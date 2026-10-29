import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
      select: {
        id: true,
        status: true,
      },
    })

    if (!project) {
      return apiNotFound('Project not found')
    }

    const topicCount = await prisma.topic.count({
      where: { projectId },
    })

    if (topicCount === 0) {
      return apiError(
        ApiErrorCode.CONFLICT,
        'Cannot confirm topics because none were found',
        undefined,
        409
      )
    }

    const [confirmedTopics, updatedProject] = await prisma.$transaction(async (tx) => {
      // The same lock the topic planner takes when it writes, so Confirm never lands in the middle
      // of a plan being stored (the planner checks the confirmed set under it).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plan:${projectId}`}))`
      const topics = await tx.topic.updateMany({
        where: { projectId },
        data: { userConfirmed: true },
      })
      // A completed course stays completed.
      const updated = await tx.project.update({
        where: { id: projectId },
        data: { status: project.status === 'completed' ? 'completed' : 'active' },
        select: { id: true, status: true },
      })
      return [topics, updated] as const
    })

    return NextResponse.json({
      project: updatedProject,
      topicsConfirmed: confirmedTopics.count,
      totalTopics: topicCount,
    })
  } catch (error) {
    console.error('Confirm topics error:', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to confirm topics')
  }
}
