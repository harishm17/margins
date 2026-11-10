/**
 * API route to get the chunking job for a material
 * GET /api/materials/[materialId]/chunking-job
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { apiNotFound, apiUnauthorized, apiInternal, isUnauthorizedError } from '@/lib/api/errors'

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const session = await requireAuth()
    const { materialId } = await params

    // Get material and verify ownership
    const material = await prisma.material.findFirst({
      where: {
        id: materialId,
        project: {
          userId: session.user.id,
        },
      },
      select: {
        id: true,
        projectId: true,
      },
    })

    if (!material) {
      return apiNotFound('Material not found')
    }

    // Find the most recent chunking job for this material
    const chunkingJob = await prisma.processingJob.findFirst({
      where: {
        projectId: material.projectId,
        jobType: 'chunk_material',
        inputData: {
          path: ['materialId'],
          equals: materialId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        status: true,
        stage: true,
        progressPercent: true,
        errorMessage: true,
        errorCode: true,
        retryable: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    })

    if (!chunkingJob) {
      return NextResponse.json({ chunkingJob: null })
    }

    return NextResponse.json({ chunkingJob })
  } catch (error) {
    logServerError('Get chunking job error', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to get chunking job')
  }
}
