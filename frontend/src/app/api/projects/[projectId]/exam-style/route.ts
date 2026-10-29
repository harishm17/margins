/**
 * POST /api/projects/[projectId]/exam-style: analyse the course's past exams again.
 *
 * Starts the style job (profile_exam) for each past-exam file that has been read but has no style
 * yet, and the job that matches past-exam questions to topics (exam_relevance). Refused like any
 * other model work while AI is unavailable or the allowance is used.
 */
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import { startExamProfileJob, startExamRelevanceJob } from '@/lib/exams/style-jobs'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const session = await requireAuth()
    const userId = session.user.id
    const { projectId } = await params
    const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
    if (!project) return apiNotFound('Course not found')

    const preflightError = await ensureAiGenerationReady(userId)
    if (preflightError) return preflightError

    const files = await prisma.material.findMany({
      where: {
        projectId,
        role: 'exam',
        validationStatus: 'valid',
        styleProfile: { equals: Prisma.AnyNull },
        materialChunks: { some: {} },
      },
      select: { id: true },
    })
    const started = await Promise.all(files.map((file) => startExamProfileJob(userId, projectId, file.id)))
    const relevance = await startExamRelevanceJob(userId, projectId)

    return NextResponse.json({
      jobIds: [...started, relevance].flatMap((job) => (job ? [job.jobId] : [])),
      started: started.filter(Boolean).length,
    })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Could not start the past-exam analysis:', error)
    return apiInternal('Could not start the past-exam analysis')
  }
}
