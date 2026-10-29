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
 * with the complete score, the same way a quiz graded at once is applied (applyQuizAttempt).
 * Until then nothing about the quiz reaches mastery, the plan or the history.
 *
 * Applying is one transaction under a row lock on the submission: the attempt and all its effects
 * commit together with `appliedAt`, so a failure or a crash part way leaves nothing behind and the
 * next look applies it again, and two looks at once apply it once (the second waits for the lock and
 * then sees `appliedAt`). There is no separate claim that could be left behind.
 */

import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { ACTIVE_JOB_STATUSES, createJobOrFindActive, gradeQuizTarget } from '@/lib/jobs/active-jobs'
import { isWaitingForAi } from '@/lib/jobs/poll-job'
import { buildReview, toStoredResults, type QuizReviewItem } from './quiz-review'
import { applyQuizAttempt } from './record-quiz-attempt'
import type { GradedQuestion } from '@/lib/ai-service/grading'

type Topic = { id: string; projectId: string }
type RawQuestion = Record<string, unknown>

export type QuizGradingStart = {
  submissionId: string
  jobId: string | null
  /** False when starting the grading job failed for good: the submission is kept and can be graded again. */
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

/** The same answers hash the same, whatever order the keys came in. */
export function answersHash(answers: Record<string, string>): string {
  const entries = Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/**
 * Start the grading job for a stored quiz and send it to the AI service. Used for the first
 * grading and for "Grade again". A grading job that is already waiting or running is returned as is,
 * so a retry and the reaper can never grade the same submission twice.
 *
 * If the AI service cannot be reached the job stays `pending` and never started: the AI service's
 * reaper sends it once it is back (see tasks/dispatch markJobFailed, which leaves it alone). Only a
 * refusal that no retry can fix fails the job here.
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
    if (retryable) return { submissionId, jobId: job.id, started: true }
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: 'ENQUEUE_PERMANENT',
        errorMessage: 'Failed to start quiz grading',
        retryable: false,
        completedAt: new Date(),
      },
    })
    return { submissionId, jobId: job.id, started: false }
  }
}

/**
 * Store a submitted quiz whose short answers cannot be graded now, and start the job that waits
 * for the AI. The same answers to the same set, still waiting, are the same submission (a double
 * click, a second tab): a unique index on waiting rows decides it, so two submits at once store one.
 */
export async function queueQuizSubmission(input: {
  userId: string
  topic: Topic
  quizSetId: string | null
  questions: RawQuestion[]
  answers: Record<string, string>
}): Promise<QuizGradingStart> {
  const { userId, topic, quizSetId, questions, answers } = input
  const hash = answersHash(answers)
  let id: string
  try {
    id = (
      await prisma.quizSubmission.create({
        data: {
          userId,
          topicId: topic.id,
          quizSetId,
          answers,
          answersHash: hash,
          questions: questions as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
    ).id
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    const existing = await prisma.quizSubmission.findFirst({
      where: { userId, topicId: topic.id, quizSetId, answersHash: hash, status: 'pending' },
      select: { id: true },
    })
    if (!existing) throw error
    id = existing.id
  }
  return startQuizGrading(userId, topic, id)
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

/**
 * Removes a stored quiz and its answers, for a card the student does not want any more. Refused
 * while its grading is still waiting or running (that one will finish by itself).
 */
export async function dismissQuizSubmission(
  userId: string,
  topicId: string,
  submissionId: string
): Promise<'deleted' | 'not_found' | 'busy'> {
  const submission = await prisma.quizSubmission.findFirst({
    where: { id: submissionId, userId, topicId, status: 'pending' },
    select: { id: true },
  })
  if (!submission) return 'not_found'
  const active = await prisma.processingJob.findFirst({
    where: { targetKey: gradeQuizTarget(submissionId), status: { in: ACTIVE_JOB_STATUSES } },
    select: { id: true },
  })
  if (active) return 'busy'
  const { count } = await prisma.quizSubmission.deleteMany({ where: { id: submissionId, userId, status: 'pending' } })
  return count > 0 ? 'deleted' : 'not_found'
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
 * the review schedule, in one transaction (see the top of this file). Null while the quiz is not
 * graded, or when it is not theirs; otherwise what the page shows. Applying it again returns the
 * same thing without applying anything.
 */
export async function applyQuizSubmission(userId: string, submissionId: string): Promise<AppliedQuiz | null> {
  return prisma.$transaction(
    async (tx) => {
      // The lock: a second look at the same submission waits here until the first has committed.
      const locked = await tx.$queryRaw<{ applied_at: Date | null }[]>`
        SELECT applied_at FROM quiz_submissions
        WHERE id = ${submissionId} AND user_id = ${userId} AND status = 'graded'
        FOR UPDATE`
      if (locked.length === 0) return null

      const submission = await tx.quizSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        include: { topic: { select: { id: true, projectId: true } } },
      })
      const grading = readGrading(submission.aiGrading)
      if (!grading) return null

      const questions = submission.questions as RawQuestion[]
      const results = toStoredResults(grading.graded)
      const answers = submission.answers as Record<string, string>
      const base = {
        attemptId: submission.id,
        score: grading.score,
        earnedPoints: grading.earned,
        totalPoints: grading.total,
        review: buildReview(questions, results),
        answers,
      }

      if (locked[0].applied_at) {
        // Applied in full already.
        const [progress, schedule] = await Promise.all([
          tx.topicProgress.findUnique({
            where: { topicId_userId: { topicId: submission.topicId, userId } },
            select: { quizScore: true },
          }),
          tx.reviewSchedule.findUnique({
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

      const recorded = await applyQuizAttempt(tx, {
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
      await tx.quizSubmission.update({ where: { id: submission.id }, data: { appliedAt: new Date() } })
      return { ...base, bestScore: recorded.bestScore, outcome: recorded.outcome }
    },
    { timeout: 20_000 }
  )
}

/**
 * Applies every graded submission that is not applied yet (a few at a time), for one course, one
 * topic, or all of the student's. Any page that shows progress, mastery or review dates calls this
 * first, so a quiz that finished grading while the student was away shows up wherever they look
 * first. A submission whose earlier apply failed or died is simply still unapplied, so it is taken
 * here again. With nothing to apply it is one small query.
 */
export async function applyPendingQuizResults(
  userId: string,
  scope: { projectId: string } | { topicId: string } | 'all' = 'all'
): Promise<number> {
  const topic =
    scope === 'all'
      ? { project: { userId } }
      : 'projectId' in scope
        ? { projectId: scope.projectId, project: { userId } }
        : { id: scope.topicId, project: { userId } }
  const pending = await prisma.quizSubmission.findMany({
    where: { userId, status: 'graded', appliedAt: null, topic },
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
