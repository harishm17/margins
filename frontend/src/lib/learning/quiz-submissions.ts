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
import { mergeRuleResults, partialSummary, type PartialQuiz, type PartialSummary } from './quiz-partial'
import { gradeAnswers as defaultGrade, GradingUnavailableError, ruleGradableIndexes } from '@/lib/ai-service/grading'
import { applyQuizAttempt, isStrongStart, quizHelp, quizOutcome, type QuizHelp, type QuizOutcome } from './record-quiz-attempt'
import { answersForGrader, answersForStorage, confidences, normalizeAnswers, plainAnswers, type QuizAnswer, type RawQuizAnswer } from './quiz-answers'
import { pendingQuizEvidence, recordAttemptEvidence, recordQuizEvidence, retryPendingQuizEvidence, takenEarlierToday } from './quiz-evidence'
import { studentTimeZone } from './student-time-zone'
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
  /** Set when the multiple choice, true or false and numerical answers were graded at once. */
  partial?: PartialQuiz
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
  /** How sure the student was, by question index, for the questions where they said. */
  confidence: Record<string, number>
  outcome: QuizOutcome
  /** Where to look for the missed questions (spec 18.5), when any named a concept. */
  help: QuizHelp | null
}

/** The same answers hash the same, whatever order the keys came in. */
export function answersHash(answers: Record<string, RawQuizAnswer>): string {
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
  /** Plain answers, or `{ answer, confidence?, thinking? }`: stored whole, so confidence survives the wait. */
  answers: Record<string, RawQuizAnswer>
  /** The rule-gradable questions' results, graded at once while the AI was down (spec 18.9). */
  ruleResults?: GradedQuestion[]
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
          ...(input.ruleResults ? { ruleResults: input.ruleResults as unknown as Prisma.InputJsonValue, ruleGradedAt: new Date() } : {}),
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

const readRuleResults = (value: unknown): GradedQuestion[] | null =>
  Array.isArray(value) && value.length > 0 ? (value as GradedQuestion[]) : null

export type { PartialQuiz, PartialSummary }

export type PartialGrading = { submission: QuizGradingStart; ruleGraded: GradedQuestion[]; summary: PartialSummary }

/**
 * The AI could not grade the short answers (spec 18.9): grade what rules can, now. The multiple choice, true or false and
 * numerical answers go to the grader alone (no model is involved), the whole quiz is stored for the short answers to be
 * graded when the AI is back, and the rule items' evidence is written at once under the submission's session key.
 *
 * Null when this is not possible, and the caller queues the whole quiz as before: the service could not be reached at all
 * (`unavailableCode` AI_UNREACHABLE, or it fails now), or the quiz has no rule-gradable question to grade early.
 */
export async function gradeRuleItemsNow(input: {
  userId: string
  topic: Topic
  quizSetId: string | null
  questions: RawQuestion[]
  given: Record<string, QuizAnswer>
  unavailableCode: string | null
  timeZone: string
  sameDayRepeat: boolean
  /** The grader, replaceable in tests. */
  grade?: (questions: unknown[], answers: Record<string, RawQuizAnswer>, only?: number[]) => Promise<{ graded_questions: GradedQuestion[] }>
}): Promise<PartialGrading | null> {
  const { userId, topic, quizSetId, questions, given } = input
  if (input.unavailableCode === 'AI_UNREACHABLE') return null
  const only = ruleGradableIndexes(questions)
  const shortCount = questions.length - only.length
  if (only.length === 0 || shortCount === 0) return null

  let ruleGraded: GradedQuestion[]
  try {
    ruleGraded = (await (input.grade ?? defaultGrade)(questions, answersForGrader(given), only)).graded_questions
  } catch (error) {
    if (error instanceof GradingUnavailableError) return null
    throw error
  }

  const submission = await queueQuizSubmission({ userId, topic, quizSetId, questions, answers: answersForStorage(given), ruleResults: ruleGraded })
  // The rule items count now, as they would in a graded quiz: level 0, under the submission's own session key. Written
  // again when the short answers land, the rule items are skipped (`skipIfPresent`).
  await recordQuizEvidence({
    userId,
    projectId: topic.projectId,
    topicId: topic.id,
    quizSetId,
    questions,
    answers: given,
    graded: ruleGraded,
    attemptId: submission.submissionId,
    timeZone: input.timeZone,
    sameDayRepeat: input.sameDayRepeat,
    skipIfPresent: true,
  })
  return { submission, ruleGraded, summary: partialSummary(ruleGraded, shortCount) }
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

/** What the partial view shows for the rule-graded questions: counts, their results with answer keys, and the student's answers. */
export function partialQuizOf(questions: RawQuestion[], rule: GradedQuestion[], rawAnswers: unknown): PartialQuiz {
  const answers = plainAnswers(normalizeAnswers(rawAnswers))
  const covered = new Set(rule.map((q) => q.question_index))
  const review = buildReview(questions, toStoredResults(rule), answers).filter((item) => covered.has(item.questionIndex))
  return { summary: partialSummary(rule, questions.length - rule.length), review, answers }
}

/** The partial result of a stored quiz that had its rule items graded early, or nothing. */
function partialOf(row: { ruleResults: unknown; questions: unknown; answers: unknown }): { partial?: PartialQuiz } {
  const rule = readRuleResults(row.ruleResults)
  if (!rule || !Array.isArray(row.questions)) return {}
  return { partial: partialQuizOf(row.questions as RawQuestion[], rule, row.answers) }
}

/** The stored quizzes of a topic that are not graded yet, with where their grading job is. */
export async function getWaitingQuizzes(userId: string, topicId: string): Promise<WaitingQuiz[]> {
  const submissions = await prisma.quizSubmission.findMany({
    where: { userId, topicId, status: 'pending' },
    orderBy: { submittedAt: 'desc' },
    select: { id: true, quizSetId: true, ruleResults: true, questions: true, answers: true },
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
      ...partialOf(row),
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
  // Evidence is written once the attempt and its effects have committed; writing it again is safe.
  const done = await prisma.$transaction(
    async (
      tx
    ): Promise<{
      applied: Omit<AppliedQuiz, 'outcome' | 'help'>
      topicId: string
      previousMastery: number | null
      questions: RawQuestion[]
      evidence: Parameters<typeof recordAttemptEvidence>[0] | null
    } | null> => {
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
      const finalGrading = readGrading(submission.aiGrading)
      if (!finalGrading) return null
      // Rule items were graded when the quiz was submitted; those results stand, and the job's cover the short answers.
      const early = readRuleResults(submission.ruleResults)
      const grading = early ? { ...finalGrading, graded: mergeRuleResults(finalGrading.graded, early) } : finalGrading

      const questions = submission.questions as RawQuestion[]
      const results = toStoredResults(grading.graded)
      const given = normalizeAnswers(submission.answers)
      const answers = plainAnswers(given)
      const base = {
        attemptId: submission.id,
        score: grading.score,
        earnedPoints: grading.earned,
        totalPoints: grading.total,
        review: buildReview(questions, results, answers),
        answers,
        confidence: confidences(given),
      }

      if (locked[0].applied_at) {
        // Applied in full already.
        const progress = await tx.topicProgress.findUnique({
          where: { topicId_userId: { topicId: submission.topicId, userId } },
          select: { quizScore: true },
        })
        return {
          applied: { ...base, bestScore: Math.max(progress?.quizScore ?? 0, grading.score) },
          topicId: submission.topicId,
          previousMastery: null,
          questions,
          evidence: null,
        }
      }

      const evidenceInput = {
        userId,
        projectId: submission.topic.projectId,
        topicId: submission.topicId,
        quizSetId: submission.quizSetId,
        questions,
        answers: given,
        graded: grading.graded,
        at: submission.submittedAt,
        // Rule items already have their events from the early grading: write only what is missing.
        skipIfPresent: early !== null,
        sameDayRepeat: await takenEarlierToday({
          userId,
          topicId: submission.topicId,
          quizSetId: submission.quizSetId,
          at: submission.submittedAt,
          timeZone: await studentTimeZone(),
          exceptId: submission.id,
        }),
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
        evidencePending: pendingQuizEvidence(evidenceInput),
        strongStart: isStrongStart(grading.graded, given, evidenceInput.sameDayRepeat),
      })
      await tx.quizSubmission.update({ where: { id: submission.id }, data: { appliedAt: new Date() } })
      const evidence = { ...evidenceInput, attemptId: submission.id, timeZone: 'UTC' }
      return { applied: { ...base, bestScore: recorded.bestScore }, topicId: submission.topicId, previousMastery: recorded.previousMastery, questions, evidence }
    },
    { timeout: 20_000 }
  )
  if (!done) return null
  if (done.evidence) await recordAttemptEvidence({ ...done.evidence, timeZone: await studentTimeZone() })
  // Read after the evidence is written: a converted topic's figures come from its concepts' memory.
  const outcome = await quizOutcome(userId, done.topicId, done.previousMastery)
  const help = await quizHelp(userId, done.topicId, done.questions, done.applied.review)
  return { ...done.applied, outcome, help }
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
  // Evidence that failed to write after an earlier attempt committed is owed; write it now (bounded).
  await retryPendingQuizEvidence(userId)
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
