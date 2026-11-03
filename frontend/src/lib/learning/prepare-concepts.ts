import { prisma } from '@/lib/db/prisma'
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight'
import { createJobOrFindActive, prepareConceptsTarget } from '@/lib/jobs/active-jobs'
import { enqueueContentGenerationJob } from '@/lib/tasks/dispatch'

/**
 * Courses planned before concepts existed get them without the student asking: opening the course
 * overview starts a `prepare_concepts` chain, which is "Prepare all topics now" limited to the
 * concepts type (the AI service walks the topics in course order, one at a time; see
 * ai-service/app/services/generation_chain.py).
 */

/** Retry a failed extraction at most once in this long, and at most this many times in all. */
export const PREPARE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
export const PREPARE_MAX_RETRIES = 3

export type PrepareConceptsAttempt = {
  /** The job's status: pending, processing, completed or failed. */
  status: string
  /** When it finished, or was created while it has not. */
  at: Date
}

export type PrepareConceptsState = {
  /** Confirmed topics, in course order. */
  confirmedTopicIds: string[]
  /** The course-level concept extraction jobs so far (not a topic's own), newest first. */
  attempts: PrepareConceptsAttempt[]
}

/**
 * The topic the chain starts at, or null when it should not start: no confirmed topic, or extraction
 * is running or finished. A course whose latest extraction failed is tried again once a day, up to
 * PREPARE_MAX_RETRIES times; after that it gets concepts as its topics are opened.
 */
export function prepareConceptsStart(state: PrepareConceptsState, now: Date = new Date()): string | null {
  if (state.confirmedTopicIds.length === 0) return null
  const [latest] = state.attempts
  if (latest) {
    if (latest.status !== 'failed') return null
    const failures = state.attempts.filter((attempt) => attempt.status === 'failed').length
    if (failures > PREPARE_MAX_RETRIES) return null
    if (now.getTime() - latest.at.getTime() < PREPARE_RETRY_AFTER_MS) return null
  }
  return state.confirmedTopicIds[0]
}

export type PrepareConceptsDeps = {
  /** The course has an active concept (one cheap query, asked first). */
  hasConcepts: (projectId: string) => Promise<boolean>
  state: (projectId: string) => Promise<PrepareConceptsState>
  /** False when the AI is unavailable or the allowance is used up. */
  aiReady: () => Promise<boolean>
  /** One job per project: false when the project's chain is already running. */
  createJob: (projectId: string, topicId: string) => Promise<{ jobId: string; created: boolean }>
  enqueue: (jobId: string, topicId: string) => Promise<void>
}

/** Start the chain if the course needs it. True when a job was started. */
export async function startPrepareConcepts(projectId: string, deps: PrepareConceptsDeps): Promise<boolean> {
  if (await deps.hasConcepts(projectId)) return false
  const topicId = prepareConceptsStart(await deps.state(projectId))
  if (!topicId || !(await deps.aiReady())) return false
  const { jobId, created } = await deps.createJob(projectId, topicId)
  if (!created) return false
  await deps.enqueue(jobId, topicId)
  return true
}

const PREFERENCES = { prepare_concepts: true }

const databaseDeps = (userId: string): PrepareConceptsDeps => ({
  hasConcepts: async (projectId) => (await prisma.concept.count({ where: { projectId, status: 'active' }, take: 1 })) > 0,
  state: async (projectId) => {
    const [topics, jobs] = await Promise.all([
      prisma.topic.findMany({
        where: { projectId, userConfirmed: true },
        select: { id: true },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.processingJob.findMany({
        // The course-level chain only: a topic's own concepts job (a student opening it, or the chain's
        // next step) neither blocks the course's retry nor spends its daily budget.
        where: {
          projectId,
          jobType: 'generate_content',
          inputData: { path: ['preferences', 'prepare_concepts'], equals: true },
          targetKey: prepareConceptsTarget(projectId),
        },
        select: { status: true, createdAt: true, completedAt: true },
        orderBy: { createdAt: 'desc' },
        take: PREPARE_MAX_RETRIES + 2,
      }),
    ])
    return {
      confirmedTopicIds: topics.map((topic) => topic.id),
      attempts: jobs.map((job) => ({ status: job.status, at: job.completedAt ?? job.createdAt })),
    }
  },
  aiReady: async () => (await ensureAiGenerationReady(userId)) === null,
  createJob: async (projectId, topicId) => {
    const { job, created } = await createJobOrFindActive({
      userId,
      projectId,
      jobType: 'generate_content',
      status: 'pending',
      stage: 'generating',
      inputData: { topicId, contentType: 'concepts', preferences: PREFERENCES },
      progressPercent: 0,
      targetKey: prepareConceptsTarget(projectId),
    })
    return { jobId: job.id, created }
  },
  enqueue: async (jobId, topicId) => {
    try {
      await enqueueContentGenerationJob(jobId, topicId, 'concepts', PREFERENCES)
    } catch (error) {
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          errorCode: 'ENQUEUE_FAILED',
          errorMessage: 'Failed to enqueue concept extraction job',
          retryable: true,
          completedAt: new Date(),
        },
      })
      throw error
    }
  },
})

/**
 * Called when the course overview is read. Never throws, and the page waits for one count query
 * only (a course that has concepts, the usual case); the rest runs in the background.
 */
export async function startPrepareConceptsForCourse(userId: string, projectId: string): Promise<void> {
  const deps = databaseDeps(userId)
  try {
    if (await deps.hasConcepts(projectId)) return
  } catch (error) {
    console.error('Could not check concepts for preparation:', error)
    return
  }
  void startPrepareConcepts(projectId, deps).catch((error) => {
    console.error('Could not start concept preparation:', error)
  })
}
