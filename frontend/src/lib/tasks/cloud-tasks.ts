/**
 * Google Cloud Tasks client wrapper
 * Handles enqueueing async jobs to the AI service
 */

import { aiServiceHeaders } from '@/lib/ai-service/headers'
import { retryDelayMs } from './retry-delay'
import { undeliveredWhere } from './undelivered'

let CloudTasksClient: any
let client: any = null

try {
  const tasks = require('@google-cloud/tasks')
  CloudTasksClient = tasks.CloudTasksClient
  const cloudTasksEnabled = process.env.ENABLE_CLOUD_TASKS === 'true'
  client = cloudTasksEnabled ? new CloudTasksClient() : null
  if (!cloudTasksEnabled) {
    console.log('Cloud Tasks disabled, using direct HTTP calls')
  }
} catch (error) {
  console.warn('Cloud Tasks not available, using direct HTTP calls')
}

const PROJECT_ID = process.env.GCS_PROJECT_ID || 'margins-dev'
const LOCATION = process.env.CLOUD_TASKS_LOCATION || 'us-central1'
const QUEUE = process.env.CLOUD_TASKS_QUEUE || 'margins-jobs'
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}
const DIRECT_TASK_TIMEOUT_MS = parsePositiveInt(process.env.DIRECT_TASK_TIMEOUT_MS, 10 * 60 * 1000)
const DIRECT_TASK_MAX_RETRIES = parsePositiveInt(process.env.DIRECT_TASK_MAX_RETRIES, 3)
const INLINE_DIRECT_JOB_TYPES = new Set(
  String(process.env.DIRECT_INLINE_JOB_TYPES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
)

export interface TaskPayload {
  jobId: string
  jobType: string
  data: Record<string, any>
}

export class TaskEnqueueError extends Error {
  retryable: boolean
  status?: number
  /** The Retry-After header of the answer, when the AI service sent one. */
  retryAfter?: string | null

  constructor(message: string, retryable = true, status?: number, retryAfter?: string | null) {
    super(message)
    this.name = 'TaskEnqueueError'
    this.retryable = retryable
    this.status = status
    this.retryAfter = retryAfter
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The AI service answers 200 for finished jobs and for jobs it skipped as already handled
// ({"status": "skipped"}), 400 for failures a retry cannot fix (missing or rejected API
// key, no credit, no source material, over the daily budget) and 5xx for transient ones: a rate
// limited or overloaded model answers 503 with a Retry-After, which the next attempt waits for.
// Only transient failures are worth another call: network errors and 5xx.
function isTransientTaskFailure(status: number): boolean {
  return status >= 500
}

async function callAiServiceWithRetry(endpoint: string, payload: TaskPayload): Promise<void> {
  let attempt = 0
  let lastError: TaskEnqueueError | null = null

  while (attempt < DIRECT_TASK_MAX_RETRIES) {
    attempt += 1
    try {
      const response = await fetch(`${AI_SERVICE_URL}${endpoint}`, {
        method: 'POST',
        headers: aiServiceHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DIRECT_TASK_TIMEOUT_MS),
      })

      if (!response.ok) {
        const message = await response.text()
        const retryable = isTransientTaskFailure(response.status)
        throw new TaskEnqueueError(
          `[DEV] Task execution failed (${response.status}): ${message}`,
          retryable,
          response.status,
          response.headers.get('retry-after')
        )
      }
      return
    } catch (error) {
      const normalized = error instanceof TaskEnqueueError
        ? error
        : new TaskEnqueueError(String(error), true)
      lastError = normalized

      if (!normalized.retryable || attempt >= DIRECT_TASK_MAX_RETRIES) {
        break
      }

      await sleep(retryDelayMs(attempt, normalized.retryAfter, Math.floor(Math.random() * 120)))
    }
  }

  throw lastError || new TaskEnqueueError('Unknown task enqueue failure')
}

async function markJobFailed(
  payload: TaskPayload,
  error: TaskEnqueueError
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    // Only a job no handler has touched (see ./undelivered): a job waiting for its retry, or one
    // whose worker died, is the AI service reaper's to send again.
    await prisma.processingJob.updateMany({
      where: undeliveredWhere(payload.jobId),
      data: {
        status: 'failed',
        errorCode: error.retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
        errorMessage: error.message.slice(0, 1000),
        retryable: error.retryable,
        completedAt: new Date(),
      },
    })
  } catch (dbError) {
    console.error('[DEV] Failed to persist enqueue failure:', dbError)
  }
}

async function dispatchDirectTask(endpoint: string, payload: TaskPayload): Promise<void> {
  try {
    await callAiServiceWithRetry(endpoint, payload)
  } catch (error) {
    const normalized = error instanceof TaskEnqueueError
      ? error
      : new TaskEnqueueError(String(error), true)
    console.error(`[DEV] Background task dispatch failed for ${payload.jobId}:`, normalized.message)
    await markJobFailed(payload, normalized)
  }
}

async function runInlineDirectTask(endpoint: string, payload: TaskPayload): Promise<void> {
  try {
    await callAiServiceWithRetry(endpoint, payload)
  } catch (error) {
    const normalized = error instanceof TaskEnqueueError
      ? error
      : new TaskEnqueueError(String(error), true)
    await markJobFailed(payload, normalized)
    throw normalized
  }
}

if (!client && INLINE_DIRECT_JOB_TYPES.size > 0) {
  console.warn(
    `[DEV] Inline direct tasks enabled for: ${Array.from(INLINE_DIRECT_JOB_TYPES).join(', ')}`
  )
}

/**
 * Enqueue a task to Cloud Tasks
 * @param endpoint - AI service endpoint (e.g., /jobs/validate-material)
 * @param payload - Task payload
 * @returns Task name
 */
export async function enqueueTask(
  endpoint: string,
  payload: TaskPayload
): Promise<string> {
  if (!client) {
    if (INLINE_DIRECT_JOB_TYPES.has(payload.jobType)) {
      // For user-driven short tasks, run inline in direct mode to reduce queue lag.
      console.log(`[DEV] Running inline task ${payload.jobType} (${payload.jobId})`)
      await runInlineDirectTask(endpoint, payload)
    } else {
      // Heavy/background tasks remain non-blocking.
      console.log(`[DEV] Enqueueing background task ${payload.jobType} (${payload.jobId})`)
      queueMicrotask(() => {
        void dispatchDirectTask(endpoint, payload)
      })
    }

    return `dev-task-${payload.jobId}`
  }

  // Production mode - use Cloud Tasks
  const parent = client.queuePath(PROJECT_ID, LOCATION, QUEUE)

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: `${AI_SERVICE_URL}${endpoint}`,
      headers: aiServiceHeaders(),
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
  }

  const [response] = await client.createTask({ parent, task })
  return response.name || `task-${payload.jobId}`
}

/**
 * Enqueue a material validation job
 * @param jobId - Processing job ID
 * @param materialId - Material ID to validate
 * @returns Task name
 */
export async function enqueueValidationJob(
  jobId: string,
  materialId: string
): Promise<string> {
  return enqueueTask('/jobs/validate-material', {
    jobId,
    jobType: 'validate_material',
    data: { materialId },
  })
}

/**
 * Enqueue a topic extraction job
 * @param jobId - Processing job ID
 * @param projectId - Project ID
 * @returns Task name
 */
export async function enqueueTopicExtractionJob(
  jobId: string,
  projectId: string
): Promise<string> {
  return enqueueTask('/jobs/extract-topics', {
    jobId,
    jobType: 'extract_topics',
    data: { projectId },
  })
}

/**
 * Enqueue a content generation job
 * @param jobId - Processing job ID
 * @param topicId - Topic ID
 * @param contentType - Type of content to generate
 * @param preferences - Generation preferences
 * @returns Task name
 */
export async function enqueueContentGenerationJob(
  jobId: string,
  topicId: string,
  contentType: string,
  preferences: Record<string, any>
): Promise<string> {
  return enqueueTask('/jobs/generate-content', {
    jobId,
    jobType: 'generate_content',
    data: { topicId, contentType, preferences },
  })
}

/**
 * Enqueue an exam grading job. The AI service loads the questions and answers from the
 * submission, so the task body stays small.
 * @param jobId - Processing job ID
 * @param submissionId - Exam submission ID
 * @param examId - Exam ID
 * @returns Task name
 */
export async function enqueueExamGradingJob(
  jobId: string,
  submissionId: string,
  examId: string
): Promise<string> {
  return enqueueTask('/jobs/grade-exam', {
    jobId,
    jobType: 'grade_exam',
    data: { submissionId, examId },
  })
}
