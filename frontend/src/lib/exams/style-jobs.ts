/**
 * Past-exam jobs the web app starts when a file's role changes. The AI service starts the same two
 * jobs itself when a past exam finishes chunking (see `_start_exam_jobs` in ai-service
 * app/api/routes/jobs.py), so these cover the other ways the set of past exams changes:
 *
 * - `profile_exam` writes the style profile of one file (a model call);
 * - `exam_relevance` recomputes which topics of the course the past exams test (a model call, skipped when nothing changed).
 *
 * Both are best effort: a student's role change or delete never fails because a job could not start.
 */

import { prisma } from '@/lib/db/prisma'
import { createJobOrFindActive } from '@/lib/jobs/active-jobs'
import { enqueueTask } from '@/lib/tasks/dispatch'
import { examProfileTarget } from './style-state'

type Started = { jobId: string }

async function start(
  userId: string,
  projectId: string,
  jobType: 'profile_exam' | 'exam_relevance',
  endpoint: string,
  data: Record<string, string>,
  targetKey: string
): Promise<Started | null> {
  try {
    const { job, created } = await createJobOrFindActive({
      userId,
      projectId,
      jobType,
      status: 'pending',
      stage: 'extracting',
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
    console.error(`Could not start ${jobType}:`, error)
    return null
  }
}

export { examProfileTarget }
export const examRelevanceTarget = (projectId: string) => `exam-relevance:${projectId}`

export const startExamProfileJob = (userId: string, projectId: string, materialId: string) =>
  start(userId, projectId, 'profile_exam', '/jobs/profile-exam', { materialId }, examProfileTarget(materialId))

export const startExamRelevanceJob = (userId: string, projectId: string) =>
  start(userId, projectId, 'exam_relevance', '/jobs/exam-relevance', { projectId }, examRelevanceTarget(projectId))
