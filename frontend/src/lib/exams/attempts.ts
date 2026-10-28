/**
 * Exam attempts, server side.
 *
 * An attempt is an ExamSubmission row. It is 'in_progress' from the moment the student
 * starts (the server stamps startedAt and deadlineAt) until it is finalised, which flips it
 * to 'submitted' and starts grading. One in_progress row per user and exam is enforced by a
 * partial unique index, so starting twice returns the same attempt.
 */

import type { ExamSubmission } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { createJobOrFindActive, gradeExamTarget, isUniqueViolation } from '@/lib/jobs/active-jobs'
import {
  deadlineFor,
  isExpired,
  readStoredAnswers,
  remainingSeconds,
  resolveFinalAnswers,
  type AnswerMap,
} from './attempt-timing'

export const ATTEMPT_IN_PROGRESS = 'in_progress'
export const ATTEMPT_SUBMITTED = 'submitted'

export type ExamRef = { id: string; projectId: string; durationMinutes: number }

/** What the browser needs to run (or resume) an attempt. */
export type AttemptView = {
  id: string
  startedAt: string
  deadlineAt: string
  remainingSeconds: number
  serverNow: string
  answers: AnswerMap
}

export type GradingStart = {
  submissionId: string
  jobId: string | null
  /** False when starting the grading job failed: the submission is kept and can be graded again. */
  started: boolean
}

export function toAttemptView(attempt: ExamSubmission, now: Date): AttemptView {
  const startedAt = attempt.startedAt ?? attempt.submittedAt
  const deadlineAt = attempt.deadlineAt ?? startedAt
  return {
    id: attempt.id,
    startedAt: startedAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    remainingSeconds: remainingSeconds(deadlineAt, now),
    serverNow: now.toISOString(),
    answers: readStoredAnswers(attempt.answers),
  }
}

/** The exam if it belongs to the user's project. */
export async function findExamForUser(userId: string, examId: string): Promise<ExamRef | null> {
  return prisma.sampleExam.findFirst({
    where: { id: examId, project: { userId } },
    select: { id: true, projectId: true, durationMinutes: true },
  })
}

/** How many questions the exam has, read in SQL so autosave does not load them all. */
export async function countQuestions(examId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT CASE WHEN jsonb_typeof(questions) = 'array' THEN jsonb_array_length(questions) ELSE 0 END::int AS count
    FROM sample_exams
    WHERE id = ${examId}
  `
  return rows[0]?.count ?? 0
}

export async function findInProgressAttempt(userId: string, examId: string) {
  return prisma.examSubmission.findFirst({
    where: { userId, sampleExamId: examId, status: ATTEMPT_IN_PROGRESS },
  })
}

/** Start an attempt, or return the one already in progress. */
export async function startAttempt(userId: string, exam: ExamRef, now = new Date()) {
  const existing = await findInProgressAttempt(userId, exam.id)
  if (existing) return existing
  try {
    return await prisma.examSubmission.create({
      data: {
        sampleExamId: exam.id,
        userId,
        answers: {},
        status: ATTEMPT_IN_PROGRESS,
        startedAt: now,
        deadlineAt: deadlineFor(now, exam.durationMinutes),
        // Only a placeholder until the attempt is submitted.
        submittedAt: now,
      },
    })
  } catch (error) {
    // Two starts at once: the partial unique index let one through.
    if (!isUniqueViolation(error)) throw error
    const winner = await findInProgressAttempt(userId, exam.id)
    if (winner) return winner
    throw error
  }
}

/**
 * Start the grading job for a submission and send it to the AI service. Used for the first
 * grading and for "grade again". A grading job that is already running is returned as is.
 */
export async function startGrading(
  userId: string,
  exam: Pick<ExamRef, 'id' | 'projectId'>,
  submissionId: string
): Promise<GradingStart> {
  const { job, created } = await createJobOrFindActive({
    userId,
    projectId: exam.projectId,
    jobType: 'grade_exam',
    status: 'pending',
    stage: 'grading',
    // Ids only: the grading task loads the questions and answers itself.
    inputData: { submissionId, examId: exam.id },
    targetKey: gradeExamTarget(submissionId),
  })
  if (!created) return { submissionId, jobId: job.id, started: true }

  try {
    const { enqueueExamGradingJob } = await import('@/lib/tasks/dispatch')
    await enqueueExamGradingJob(job.id, submissionId, exam.id)
    return { submissionId, jobId: job.id, started: true }
  } catch (error) {
    console.error('Error enqueuing grading job:', error)
    const retryable =
      typeof (error as { retryable?: unknown })?.retryable === 'boolean'
        ? Boolean((error as { retryable: boolean }).retryable)
        : true
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
        errorMessage: 'Failed to start exam grading',
        retryable,
        completedAt: new Date(),
      },
    })
    return { submissionId, jobId: job.id, started: false }
  }
}

/**
 * Finalise an in-progress attempt and start grading. The answers graded are decided by
 * resolveFinalAnswers: the ones sent with the request while time remains, otherwise the
 * last autosave. Safe to call twice: only one call flips the status; the other gets the
 * same submission and job back.
 */
export async function finalizeAttempt(
  userId: string,
  exam: ExamRef,
  attempt: ExamSubmission,
  submitted: AnswerMap | null,
  now = new Date()
): Promise<GradingStart & { usedSubmittedAnswers: boolean }> {
  const { answers, usedSubmitted } = resolveFinalAnswers({
    saved: readStoredAnswers(attempt.answers),
    submitted,
    deadlineAt: attempt.deadlineAt ?? now,
    now,
  })

  const flipped = await prisma.examSubmission.updateMany({
    where: { id: attempt.id, userId, status: ATTEMPT_IN_PROGRESS },
    data: { status: ATTEMPT_SUBMITTED, answers, answersSavedAt: now, submittedAt: now },
  })

  if (flipped.count === 0) {
    // Someone else finalised it first (a double click, or the auto-submit and a reload).
    const job = await prisma.processingJob.findFirst({
      where: { userId, jobType: 'grade_exam', targetKey: gradeExamTarget(attempt.id) },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    return {
      submissionId: attempt.id,
      jobId: job?.id ?? null,
      started: true,
      usedSubmittedAnswers: usedSubmitted,
    }
  }

  const grading = await startGrading(userId, exam, attempt.id)
  return { ...grading, usedSubmittedAnswers: usedSubmitted }
}

/**
 * The student's attempt state for an exam. An attempt whose time (and grace) ran out while
 * the student was away is submitted here, as saved, so closing the tab does not lose it.
 */
export async function loadAttemptState(
  userId: string,
  exam: ExamRef,
  now = new Date()
): Promise<
  | { kind: 'none' }
  | { kind: 'active'; attempt: AttemptView }
  | { kind: 'finalized'; submissionId: string; jobId: string | null }
> {
  const attempt = await findInProgressAttempt(userId, exam.id)
  if (!attempt) return { kind: 'none' }

  if (attempt.deadlineAt && isExpired(attempt.deadlineAt, now)) {
    const result = await finalizeAttempt(userId, exam, attempt, null, now)
    return { kind: 'finalized', submissionId: result.submissionId, jobId: result.jobId }
  }
  return { kind: 'active', attempt: toAttemptView(attempt, now) }
}
