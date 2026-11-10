/**
 * Starts one background job the web app (not the student's request) asks the AI service for: the row, then the task.
 * The row is created through `createJobOrFindActive`, so a job already running for the same target is returned instead
 * of started twice. If the task cannot be queued the row is failed (retryable) so it does not sit as pending, and the
 * error is logged by class and code. Best effort: a caller whose own work already happened (a role change, a delete)
 * never fails because a job could not start; it gets null.
 *
 * A job type that is not in `GENERATION_JOB_TYPES` (lib/api/quota.ts) stays out of the student's daily request count.
 */

import { logServerError } from '@/lib/ops/log'
import { prisma } from '@/lib/db/prisma'
import { createJobOrFindActive } from '@/lib/jobs/active-jobs'
import { enqueueTask } from '@/lib/tasks/dispatch'

export type StartedJob = { jobId: string }

export async function startBackgroundJob(input: {
  userId: string
  projectId: string
  jobType: string
  /** The AI service path of the job, e.g. '/jobs/profile-exam'. */
  endpoint: string
  /** What the job acts on: the row's inputData and the task's `data`. */
  data: Record<string, string>
  targetKey: string
  stage: string
}): Promise<StartedJob | null> {
  const { userId, projectId, jobType, endpoint, data, targetKey, stage } = input
  try {
    const { job, created } = await createJobOrFindActive({
      userId,
      projectId,
      jobType,
      status: 'pending',
      stage,
      inputData: data,
      progressPercent: 0,
      targetKey,
    })
    if (!created) return { jobId: job.id }
    try {
      await enqueueTask(endpoint, { jobId: job.id, jobType, data })
    } catch (error) {
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: 'ENQUEUE_FAILED',
          errorMessage: `Could not start ${jobType}`,
          retryable: true,
          completedAt: new Date(),
        },
      })
      throw error
    }
    return { jobId: job.id }
  } catch (error) {
    logServerError('Could not start a background job', error, { jobType })
    return null
  }
}
