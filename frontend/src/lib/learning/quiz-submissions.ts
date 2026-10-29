/**
 * Topic quizzes that waited for the AI.
 *
 * A quiz is graded at once when it can be (rules for the choice questions, the model for short
 * answers). When the model cannot be reached the submission is stored here, whole, and a
 * `grade_quiz` job waits for the AI exactly like exam grading (ai-service job_runner
 * `wait_for_ai`): it goes back to `pending` at the stage `waiting_for_ai` without using an attempt,
 * the reaper sends it again when the AI is available, and after JOB_AI_WAIT_MAX_SECONDS it fails
 * (retryable: "Grade again").
 *
 * The job only grades: it stores the result on the submission. This module turns a graded
 * submission into the student's attempt, once, and applies it (progress, mastery, review date)
 * with the complete score, the same way a quiz graded at once is applied (recordQuizAttempt).
 * Until then nothing about the quiz reaches mastery, the plan or the history.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { createJobOrFindActive, gradeQuizTarget } from '@/lib/jobs/active-jobs'
import { isWaitingForAi } from '@/lib/jobs/poll-job'
import { buildReview, toStoredResults, type QuizReviewItem } from './quiz-review'
import { recordQuizAttempt } from './record-quiz-attempt'
import type { GradedQuestion } from '@/lib/ai-service/grading'

type Topic = { id: string; projectId: string }
type RawQuestion = Record<string, unknown>

export type QuizGradingStart = {
  submissionId: string
  jobId: string | null
  /** False when starting the grading job failed: the submission is kept and can be graded again. */
  started: boolean
}

/** Where a stored quiz is: waiting for the AI, being graded, or its grading did not finish. */
export type WaitingQuizState = 'waiting' | 'grading' | 'failed'

export type WaitingQuiz = {
  submissionId: string
  /** The set the answers were for, 'legacy' for the first quiz. */
  setId: string
  jobId: string | null
  state: WaitingQuizState
  errorCode: string | null
}

/** What the page shows for a quiz once it is graded (the same as a quiz graded at once). */
export type AppliedQuiz = {
  attemptId: string
  score: number
  earnedPoints: number
  totalPoints: number
  bestScore: number
  review: QuizReviewItem[]
  /** The student's own answers, for the review list. */
  answers: Record<string, string>
  outcome: { nextReviewAt: Date | null; mastery: number | null; previousMastery: number | null }
}

const STALE_CLAIM_MS = 5 * 60_000

export const sameAnswers = (a: unknown, b: Record<string, string>): boolean => {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false
  const left = Object.entries(a as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y))
  return left.length === right.length && left.every(([key, value], index) => key === right[index][0] && value === right[index][1])
}

/**
 * Start the grading job for a stored quiz and send it to the AI service. Used for the first
 * grading and for "Grade again". A grading job that is already waiting or running is returned as is,
 * so a retry and the reaper can never grade the same submission twice.
 */
export async function startQuizGrading(userId: string, topic: Topic, submissionId: string): Promise<QuizGradingStart> {
  const { job, created } = await createJobOrFindActive({
    userId,
    projectId: topic.projectId,
    jobType: 'grade_quiz',
    status: 'pending',
    stage: 'grading',
    // Ids only: the grading task loads the questions and answers itself.
    inputData: { submissionId, topicId: topic.id },
    targetKey: gradeQuizTarget(submissionId),
  })
  if (!created) return { submissionId, jobId: job.id, started: true }

  try {
    const { enqueueQuizGradingJob } = await import('@/lib/tasks/dispatch')
    await enqueueQuizGradingJob(job.id, submissionId)
    return { submissionId, jobId: job.id, started: true }
  } catch (error) {
    console.error('Error enqueuing quiz grading job:', error)
    const retryable =
      typeof (error as { retryable?: unknown })?.retryable === 'boolean'
        ? Boolean((error as { retryable: boolean }).retryable)
        : true
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
        errorMessage: 'Failed to start quiz grading',
        retryable,
        completedAt: new Date(),
      },
    })
    return { submissionId, jobId: job.id, started: false }
  }
}

/**
 * Store a submitted quiz whose short answers cannot be graded now, and start the job that waits
 * for the AI. The same answers to the same set, still waiting, are the same submission (a double
 * click, or a second tab), so they are not stored twice.
 */
export async function queueQuizSubmission(input: {
  userId: string
  topic: Topic
  quizSetId: string | null
  questions: RawQuestion[]
  answers: Record<string, string>
}): Promise<QuizGradingStart> {
  const { userId, topic, quizSetId, questions, answers } = input
  const waiting = await prisma.quizSubmission.findMany({
    where: { userId, topicId: topic.id, quizSetId, status: 'pending' },
    select: { id: true, answers: true },
  })
  const same = waiting.find((row) => sameAnswers(row.answers, answers))
  const id =
    same?.id ??
    (
      await prisma.quizSubmission.create({
        data: {
          userId,
          topicId: topic.id,
          quizSetId,
          answers,
          questions: questions as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
    ).id
  return startQuizGrading(userId, topic, id)
}

/** The stored quizzes of a topic that are not graded yet, with where their grading job is. */
export async function getWaitingQuizzes(userId: string, topicId: string): Promise<WaitingQuiz[]> {
  const submissions = await prisma.quizSubmission.findMany({
    where: { userId, topicId, status: 'pending' },
    orderBy: { submittedAt: 'desc' },
    select: { id: true, quizSetId: true },
  })
  if (submissions.length === 0) return []
  const jobs = await prisma.processingJob.findMany({
    where: { userId, jobType: 'grade_quiz', targetKey: { in: submissions.map((row) => gradeQuizTarget(row.id)) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, targetKey: true, status: true, stage: true, errorCode: true },
  })
  const latest = new Map<string, (typeof jobs)[number]>()
  for (const job of jobs) if (job.targetKey && !latest.has(job.targetKey)) latest.set(job.targetKey, job)

  return submissions.map((row) => {
    const job = latest.get(gradeQuizTarget(row.id))
    const state = waitingState(job)
    return {
      submissionId: row.id,
      setId: row.quizSetId ?? 'legacy',
      jobId: job && job.status !== 'failed' ? job.id : null,
      state,
      errorCode: job?.status === 'failed' ? job.errorCode : null,
    }
  })
}

export function readGrading(value: unknown): { graded: GradedQuestion[]; score: number; earned: number; total: number } | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.graded_questions)) return null
  if (typeof record.overall_score !== 'number') return null
  return {
    graded: record.graded_questions as GradedQuestion[],
    score: record.overall_score,
    earned: typeof record.earned_points === 'number' ? record.earned_points : 0,
    total: typeof record.total_points === 'number' ? record.total_points : 0,
  }
}

/**
 * Turns one graded submission into the student's attempt and applies it to progress, mastery and
 * the review schedule. It runs once per submission: `appliedAt` is claimed first with a conditional
 * update, so two pages that look together apply it once, and a failure puts the claim back so the
 * next look tries again. Null while the quiz is not graded (or not applied yet by whoever holds the
 * claim); otherwise what the page shows. Null also when the submission is not theirs.
 */
export async function applyQuizSubmission(userId: string, submissionId: string): Promise<AppliedQuiz | null> {
  const submission = await prisma.quizSubmission.findFirst({
    where: { id: submissionId, userId },
    include: { topic: { select: { id: true, projectId: true } } },
  })
  if (!submission || submission.status !== 'graded') return null
  const grading = readGrading(submission.aiGrading)
  if (!grading) return null

  const questions = submission.questions as RawQuestion[]
  const results = toStoredResults(grading.graded)
  const review = buildReview(questions, results)
  const answers = submission.answers as Record<string, string>
  const base = { attemptId: submission.id, score: grading.score, earnedPoints: grading.earned, totalPoints: grading.total, review, answers }

  // The attempt is the submission under the same id: when it exists, the quiz is applied.
  const attempt = await prisma.quizAttempt.findUnique({ where: { id: submission.id }, select: { id: true } })
  const claim = attempt
    ? { count: 0 }
    : await prisma.quizSubmission.updateMany({
        // Not claimed, or claimed so long ago that whoever held it must have died before storing the attempt.
        where: {
          id: submission.id,
          userId,
          status: 'graded',
          OR: [{ appliedAt: null }, { appliedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }],
        },
        data: { appliedAt: new Date() },
      })

  if (claim.count === 0) {
    // Applied already (or being applied right now). The attempt is what counts.
    if (!attempt) return null
    const [progress, schedule] = await Promise.all([
      prisma.topicProgress.findUnique({
        where: { topicId_userId: { topicId: submission.topicId, userId } },
        select: { quizScore: true },
      }),
      prisma.reviewSchedule.findUnique({
        where: { userId_topicId: { userId, topicId: submission.topicId } },
        select: { dueAt: true, mastery: true },
      }),
    ])
    return {
      ...base,
      bestScore: Math.max(progress?.quizScore ?? 0, grading.score),
      outcome: { nextReviewAt: schedule?.dueAt ?? null, mastery: schedule?.mastery ?? null, previousMastery: null },
    }
  }

  try {
    const recorded = await recordQuizAttempt({
      userId,
      topic: submission.topic,
      quizSetId: submission.quizSetId,
      answers,
      results: results as unknown as Prisma.InputJsonValue,
      score: grading.score,
      // The attempt is the submission, taken when the student submitted it.
      id: submission.id,
      takenAt: submission.submittedAt,
    })
    return { ...base, bestScore: recorded.bestScore, outcome: recorded.outcome }
  } catch (error) {
    await prisma.quizSubmission
      .updateMany({ where: { id: submission.id, userId }, data: { appliedAt: null } })
      .catch(() => undefined)
    throw error
  }
}

/**
 * Applies every graded submission not applied yet (a few at a time) for one course or one topic, so
 * mastery, the plan and the history are current before a page reads them.
 */
export async function applyPendingQuizResults(
  userId: string,
  scope: { projectId: string } | { topicId: string }
): Promise<number> {
  const pending = await prisma.quizSubmission.findMany({
    where: {
      userId,
      status: 'graded',
      appliedAt: null,
      topic: 'projectId' in scope ? { projectId: scope.projectId, project: { userId } } : { id: scope.topicId, project: { userId } },
    },
    orderBy: { gradedAt: 'asc' },
    take: 10,
    select: { id: true },
  })
  let applied = 0
  for (const { id } of pending) {
    try {
      if (await applyQuizSubmission(userId, id)) applied += 1
    } catch (error) {
      console.error('Applying a graded quiz to mastery failed:', error)
    }
  }
  return applied
}

/**
 * Where a stored quiz is, from its latest grading job: no job, or one that failed (it waited for the
 * whole limit, or could not start), is a grading that did not finish; a job at the stage
 * `waiting_for_ai` is waiting for the AI; anything else is being graded.
 */
export function waitingState(job: { status: string; stage?: string | null } | undefined): WaitingQuizState {
  if (!job || job.status === 'failed') return 'failed'
  return isWaitingForAi(job) ? 'waiting' : 'grading'
}
