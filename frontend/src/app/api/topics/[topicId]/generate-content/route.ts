/**
 * API route for content generation
 * POST /api/topics/[topicId]/generate-content
 */

import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { enqueueContentGenerationJob, TaskEnqueueError } from '@/lib/tasks/dispatch'
import { z } from 'zod'
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
  generateContentTarget,
} from '@/lib/jobs/active-jobs'
import { resolveRequestedContent } from '@/lib/learning/topic-preparation'

const generateContentSchema = z.object({
  contentType: z.enum(['concepts', 'warmup', 'section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz']),
  preferences: z.object({
    detail_level: z.enum(['brief', 'moderate', 'comprehensive']).optional(),
    include_examples: z.boolean().optional(),
    count: z.number().min(1).max(10).optional(),
    question_count: z.number().min(5).max(30).optional(),
    difficulty_level: z.enum(['easy', 'medium', 'hard']).optional(),
    focus: z.string().trim().min(3).max(280).optional(),
    question_types: z.array(z.enum(['multiple_choice', 'short_answer', 'numerical', 'true_false'])).max(4).optional(),
    append: z.boolean().optional(),
    // When this job finishes, the AI service queues the topic's other missing content one job at
    // a time (see ai-service/app/services/generation_chain.py). Set when a topic is opened.
    prepare_rest: z.boolean().optional(),
    // Start only if the topic has no content of this type yet. A page that is opened twice (a
    // remount, a refresh just after the job finished) must not write the notes a second time.
    only_if_missing: z.boolean().optional(),
  }).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership through project
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
      include: {
        project: true,
      },
    })

    if (!topic) {
      return apiNotFound('Topic not found')
    }

    const preflightError = await ensureAiGenerationReady(session.user.id)
    if (preflightError) {
      return preflightError
    }

    const validation = await readJson(request, generateContentSchema)
    if (!validation.ok) return validation.response

    const { contentType: requestedType, preferences: requested } = validation.data
    const { only_if_missing: onlyIfMissing, ...preferences } = requested ?? {}
    // Opening a topic asks for its concepts and the rest of its chain: a topic that has the
    // concepts already goes on with the first type it is missing, and concepts already being
    // extracted (by a course-wide run, say) are followed, not started again.
    const resolved = await resolveRequestedContent({
      topicId,
      contentType: requestedType,
      onlyIfMissing: !!onlyIfMissing,
      prepareRest: !!preferences.prepare_rest,
    })
    if (resolved.kind === 'exists') {
      return NextResponse.json({ jobId: null, status: 'exists', message: 'Content already written' })
    }
    if (resolved.kind === 'active') {
      return NextResponse.json({
        jobId: resolved.jobId,
        contentType: requestedType,
        status: resolved.status === 'processing' ? 'processing' : 'queued',
        message: 'Content generation already in progress',
        estimatedSeconds: 60,
        replacingExisting: false,
      })
    }
    const { contentType } = resolved
    const existingContent = resolved.replacing

    // One generation per topic and content type at a time (a unique target key), so a
    // double click or a second tab gets the job that is already running.
    const targetKey = generateContentTarget(topicId, contentType)

    const { job, created } = await createJobOrFindActive({
      userId: session.user.id,
      projectId: topic.projectId,
      jobType: 'generate_content',
      status: 'pending',
      stage: 'generating',
      inputData: {
        topicId,
        contentType,
        preferences: preferences || {},
      },
      progressPercent: 0,
      targetKey,
    })

    if (!created) {
      return NextResponse.json({
        jobId: job.id,
        contentType,
        status: job.status === 'processing' ? 'processing' : 'queued',
        message: 'Content generation already in progress',
        estimatedSeconds: 60,
        replacingExisting: existingContent,
      })
    }

    // Enqueue content generation task
    try {
      await enqueueContentGenerationJob(job.id, topicId, contentType, preferences || {})
    } catch (enqueueError) {
      const retryable = enqueueError instanceof TaskEnqueueError
        ? enqueueError.retryable
        : true
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
          errorMessage: 'Failed to enqueue content generation job',
          retryable,
          completedAt: new Date(),
        },
      })
      return apiUpstream('Failed to start content generation')
    }

    return NextResponse.json({
      jobId: job.id,
      contentType,
      status: 'queued',
      message: 'Content generation started',
      estimatedSeconds: 60,
      replacingExisting: existingContent,
    })
  } catch (error) {
    console.error('Content generation error:', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to start content generation')
  }
}
