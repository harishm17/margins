import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { enqueueContentGenerationJob, TaskEnqueueError } from '@/lib/tasks/cloud-tasks'
import { apiInvalidInput, apiUpstream } from '@/lib/api/errors'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import { createJobOrFindActive, generateContentTarget } from '@/lib/jobs/active-jobs'

export const regenerateContentSchema = z.object({
  contentType: z.enum(['section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz']),
  preferences: z
    .object({
      detail_level: z.enum(['brief', 'moderate', 'comprehensive']).optional(),
      include_examples: z.boolean().optional(),
      count: z.number().min(1).max(10).optional(),
      question_count: z.number().min(5).max(30).optional(),
      difficulty_level: z.enum(['easy', 'medium', 'hard']).optional(),
      focus: z.string().trim().min(3).max(280).optional(),
      question_types: z.array(z.enum(['multiple_choice', 'short_answer', 'numerical', 'true_false'])).optional(),
      append: z.boolean().optional(),
      variation_seed: z.number().optional(), // Used to ensure different content each time
      // A quiz set that also asks 1-2 questions from one of the topic's prerequisite topics (a review).
      prerequisite_topic_id: z.string().min(1).max(64).optional(),
      prerequisite_questions: z.number().int().min(1).max(2).optional(),
    })
    .optional(),
})

export type RegenerateContentInput = z.infer<typeof regenerateContentSchema>

/**
 * Starts the regeneration job for one kind of content of a topic (a new quiz set, more examples, a
 * rewritten note) and answers as POST /api/topics/[id]/regenerate-content does. There is one job
 * per topic and content type at a time, so a double click gets the job already running. The caller
 * has checked that the topic is the user's.
 */
export async function startRegeneration(input: {
  userId: string
  topic: { id: string; projectId: string }
  contentType: RegenerateContentInput['contentType']
  preferences?: NonNullable<RegenerateContentInput['preferences']>
}): Promise<NextResponse> {
  const { userId, topic, contentType, preferences } = input

  const preflightError = await ensureAiGenerationReady(userId)
  if (preflightError) return preflightError

  // A prerequisite to draw review questions from must be another topic of the same course.
  if (preferences?.prerequisite_topic_id) {
    const prerequisite = await prisma.topic.findFirst({
      where: { id: preferences.prerequisite_topic_id, projectId: topic.projectId, project: { userId } },
      select: { id: true },
    })
    if (!prerequisite || prerequisite.id === topic.id) {
      return apiInvalidInput('The prerequisite topic must be another topic of this course')
    }
  }

  const targetKey = generateContentTarget(topic.id, contentType)

  // The timestamp is a variation seed, so the content differs each time.
  const enhancedPreferences = {
    ...(preferences || {}),
    variation_seed: Date.now(),
    regeneration: true,
  }

  const { job, created } = await createJobOrFindActive({
    userId,
    projectId: topic.projectId,
    jobType: 'generate_content',
    status: 'pending',
    stage: 'generating',
    inputData: {
      topicId: topic.id,
      contentType,
      preferences: enhancedPreferences,
    },
    progressPercent: 0,
    targetKey,
  })

  if (!created) {
    return NextResponse.json({
      jobId: job.id,
      status: job.status === 'processing' ? 'processing' : 'queued',
      message: 'Content regeneration already in progress',
      estimatedSeconds: 60,
    })
  }

  try {
    await enqueueContentGenerationJob(job.id, topic.id, contentType, enhancedPreferences)
  } catch (enqueueError) {
    const retryable = enqueueError instanceof TaskEnqueueError ? enqueueError.retryable : true
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
        errorMessage: 'Failed to enqueue content regeneration job',
        retryable,
        completedAt: new Date(),
      },
    })
    return apiUpstream('Failed to start content regeneration')
  }

  return NextResponse.json({
    jobId: job.id,
    status: 'queued',
    message: 'Content regeneration started',
    estimatedSeconds: 60,
  })
}
