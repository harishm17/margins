/**
 * API route for topic extraction
 * POST /api/projects/[projectId]/extract-topics
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { enqueueTopicExtractionJob, TaskEnqueueError } from '@/lib/tasks/cloud-tasks'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  apiUpstream,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import {
  createJobOrFindActive,
  extractTopicsTarget,
} from '@/lib/jobs/active-jobs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return apiNotFound('Project not found')
    }

    // Check if project has valid materials
    const validMaterialsCount = await prisma.material.count({
      where: {
        projectId,
        validationStatus: 'valid',
      },
    })

    if (validMaterialsCount === 0) {
      return NextResponse.json(
        { error: { code: 'CONFLICT', message: 'No valid materials found. Please upload and validate materials first.' } },
        { status: 409 }
      )
    }

    // Check if materials have been chunked
    const chunkedMaterialsCount = await prisma.material.count({
      where: {
        projectId,
        validationStatus: 'valid',
        materialChunks: {
          some: {},
        },
      },
    })

    if (chunkedMaterialsCount === 0) {
      return NextResponse.json(
        { error: { code: 'CONFLICT', message: 'Materials are still being processed. Please wait a moment and try again.' } },
        { status: 409 }
      )
    }

    const preflightError = await ensureAiGenerationReady(session.user.id)
    if (preflightError) {
      return preflightError
    }

    // One extraction per project at a time, including the one the AI service starts itself
    // after chunking: the unique target key hands every caller the same job.
    const targetKey = extractTopicsTarget(projectId)
    const { job, created } = await createJobOrFindActive({
      userId: session.user.id,
      projectId,
      jobType: 'extract_topics',
      status: 'pending',
      stage: 'extracting',
      inputData: { projectId },
      progressPercent: 0,
      targetKey,
    })

    if (!created) {
      return NextResponse.json({
        jobId: job.id,
        status: job.status === 'processing' ? 'processing' : 'queued',
        message: 'Topic extraction already in progress',
        estimatedSeconds: 45,
      })
    }

    // Enqueue topic extraction task
    try {
      await enqueueTopicExtractionJob(job.id, projectId)
    } catch (enqueueError) {
      const retryable = enqueueError instanceof TaskEnqueueError
        ? enqueueError.retryable
        : true
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
          errorMessage: 'Failed to enqueue topic extraction job',
          retryable,
          completedAt: new Date(),
        },
      })
      return apiUpstream('Failed to start topic extraction')
    }

    return NextResponse.json({
      jobId: job.id,
      status: 'queued',
      message: 'Topic extraction started',
      estimatedSeconds: 45,
    })
  } catch (error) {
    console.error('Topic extraction error:', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to start topic extraction')
  }
}
