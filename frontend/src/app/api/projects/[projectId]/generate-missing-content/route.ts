/**
 * POST /api/projects/[projectId]/generate-missing-content
 *
 * "Prepare all topics now". Content is normally written when a student opens a topic; this
 * writes what is missing for the whole course, in course order, one topic at a time.
 *
 * It starts the first job only: the first confirmed topic with something missing, with
 * `prepare_all` in the job's preferences. When that job finishes the AI service queues the
 * topic's next missing type, and once the topic is complete the next topic's first one (see
 * ai-service/app/services/generation_chain.py), so at most one topic is in flight and a run
 * keeps going when the student closes the tab. Nothing starts while the course already has a
 * generation job running.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import { enqueueContentGenerationJob, TaskEnqueueError } from '@/lib/tasks/dispatch'
import {
  ACTIVE_JOB_STATUSES,
  createJobOrFindActive,
  generateContentTarget,
} from '@/lib/jobs/active-jobs'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

// The order a student meets them in, and so the order they are written in.
const CONTENT_ORDER = ['section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz'] as const

export const dynamic = 'force-dynamic'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: auth.user.id },
      select: { id: true },
    })
    if (!project) return apiNotFound('Project not found')

    const preflightError = await ensureAiGenerationReady(auth.user.id)
    if (preflightError) return preflightError

    const [topics, activeJobs] = await Promise.all([
      prisma.topic.findMany({
        where: { projectId, userConfirmed: true },
        select: { id: true, content: { select: { contentType: true } } },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.processingJob.count({
        where: { projectId, jobType: 'generate_content', status: { in: ACTIVE_JOB_STATUSES } },
      }),
    ])

    const missing = topics
      .map((topic) => {
        const present = new Set(topic.content.map((item) => item.contentType))
        return { topicId: topic.id, types: CONTENT_ORDER.filter((type) => !present.has(type)) }
      })
      .filter((topic) => topic.types.length > 0)

    if (missing.length === 0) {
      return NextResponse.json({
        status: 'noop',
        queuedJobs: 0,
        topicsToPrepare: 0,
        message: 'All the study content is already written.',
      })
    }
    if (activeJobs > 0) {
      return NextResponse.json({
        status: 'already_running',
        queuedJobs: 0,
        topicsToPrepare: missing.length,
        message: 'Margins is already writing content for this course.',
      })
    }

    const first = missing[0]
    const contentType = first.types[0]
    const preferences = { prepare_all: true }
    const { job, created } = await createJobOrFindActive({
      userId: auth.user.id,
      projectId,
      jobType: 'generate_content',
      status: 'pending',
      stage: 'generating',
      inputData: { topicId: first.topicId, contentType, preferences },
      progressPercent: 0,
      targetKey: generateContentTarget(first.topicId, contentType),
    })
    if (!created) {
      return NextResponse.json({
        status: 'already_running',
        queuedJobs: 0,
        topicsToPrepare: missing.length,
        message: 'Margins is already writing content for this course.',
      })
    }

    try {
      await enqueueContentGenerationJob(job.id, first.topicId, contentType, preferences)
    } catch (enqueueError) {
      const retryable = enqueueError instanceof TaskEnqueueError ? enqueueError.retryable : true
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
      return NextResponse.json(
        { status: 'failed', queuedJobs: 0, topicsToPrepare: missing.length, message: "Couldn't start writing. Try again." },
        { status: 502 }
      )
    }

    return NextResponse.json({
      status: 'queued',
      queuedJobs: 1,
      topicsToPrepare: missing.length,
      message: `Writing content for ${missing.length} topic${missing.length === 1 ? '' : 's'}, one at a time.`,
    })
  } catch (error) {
    console.error('Prepare all topics error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to queue missing content generation')
  }
}
