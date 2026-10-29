/**
 * What the job status API returns. Listing fields explicitly keeps inputData out of every
 * response: it can hold a student's full exam answers and is never needed by the browser.
 */

import type { Prisma } from '@prisma/client'

export const JOB_STATUS_SELECT = {
  id: true,
  projectId: true,
  jobType: true,
  status: true,
  stage: true,
  progressPercent: true,
  retryable: true,
  errorCode: true,
  errorMessage: true,
  attemptCount: true,
  resultData: true,
  targetKey: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.ProcessingJobSelect

export type JobStatusRow = Prisma.ProcessingJobGetPayload<{ select: typeof JOB_STATUS_SELECT }>

const stageByJobType: Record<string, string> = {
  validate_material: 'validating',
  chunk_material: 'chunking',
  extract_topics: 'extracting',
  generate_content: 'generating',
  generate_exam: 'generating',
  grade_exam: 'grading',
  grade_quiz: 'grading',
}

export function serializeJob(job: JobStatusRow) {
  return {
    ...job,
    stage: job.stage || stageByJobType[job.jobType] || null,
  }
}
