/**
 * API route for quiz attempts
 * POST /api/topics/[topicId]/quiz-attempts - Grade and save a quiz attempt. Short answers the model cannot
 *   grade right now are stored with the submission and graded when the AI is back (202, status "waiting").
 * GET /api/topics/[topicId]/quiz-attempts - Get quiz history
 */

import { logServerError } from '@/lib/ops/log'
import { id, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { ownedTopic } from '@/server/owned'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { isStrongStart, quizHelp, quizOutcome, recordQuizAttempt } from '@/lib/learning/record-quiz-attempt'
import { gradeRuleItemsNow, partialQuizOf, queueQuizSubmission } from '@/lib/learning/quiz-submissions'
import { gradeAnswers, GradingRejectedError, GradingUnavailableError } from '@/lib/ai-service/grading'
import { ApiErrorCode, apiError } from '@/lib/api/errors'
import { loadAllQuizQuestionSets, loadQuizQuestions } from '@/lib/learning/quiz-sets'
import { buildReview, toStoredResults } from '@/lib/learning/quiz-review'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { answersForGrader, answersForStorage, confidences, dontKnowIndexes, normalizeAnswers, plainAnswers } from '@/lib/learning/quiz-answers'
import { pendingQuizEvidence, recordAttemptEvidence, takenEarlierToday } from '@/lib/learning/quiz-evidence'
import { getTimeZone } from '@/server/timezone'

// The client sends answers only. Anything else in the body (a score, per-question
// results) is dropped by zod and never read: the server grades from the stored questions.
// An answer is the plain string (a quiz started before confidence existed) or an object with the
// student's confidence and thinking; a confidence outside 0 to 1 is dropped by normalizeAnswers.
const saveQuizAttemptSchema = z.object({
  answers: record(
    z.union([
      z.string().max(5000),
      z.object({
        answer: z.string().max(5000),
        confidence: z.number().optional(),
        confidenceLevel: z.enum(['guess', 'unsure', 'fairly', 'certain']).optional(),
        thinking: z.string().max(4000).optional(),
        idk: z.boolean().optional(),
      }),
    ]),
    200,
    20
  ), // { questionIndex: answer | { answer, confidence, confidenceLevel, thinking, idk } }
  quizSetId: id().optional(),
})

// Each submission can cost model calls for short answers.
const submitLimiter = createRateLimiter({ name: 'quiz-submit', limit: 10, windowMs: 60_000 })

function isMissingQuizSetColumnError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false
  }
  if (error.code !== 'P2022') {
    return false
  }

  const column = String(error.meta?.column || '').toLowerCase()
  const message = String(error.message || '').toLowerCase()

  return (
    column.includes('quiz_set_id') ||
    column.includes('quizsetid') ||
    message.includes('quiz_set_id') ||
    message.includes('quizsetid')
  )
}

async function handlePOST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership
    const topic = await ownedTopic(session.user.id, topicId)

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    const validation = await readJson(request, saveQuizAttemptSchema)
    if (!validation.ok) return validation.response

    const rate = await submitLimiter.check(session.user.id)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'Too many quiz submissions. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    const quizSetId = validation.data.quizSetId || null
    const questions = await loadQuizQuestions(topic, quizSetId)
    if (!questions) {
      return NextResponse.json({ error: 'Quiz not found' }, { status: 404 })
    }

    const given = normalizeAnswers(validation.data.answers)
    const answers = plainAnswers(given)
    const timeZone = await getTimeZone()
    // The identical set again the same local day: the answers were seen minutes ago, so the evidence is level 2 (spec 7.3).
    const sameDayRepeat = await takenEarlierToday({ userId: session.user.id, topicId, quizSetId, at: new Date(), timeZone })
    let graded
    try {
      graded = await gradeAnswers({ userId: session.user.id, projectId: topic.projectId }, questions, answersForGrader(given))
    } catch (gradeError) {
      if (gradeError instanceof GradingRejectedError) {
        // The grader refused the request itself (not the AI being away): an error, not a wait.
        const unreadable = gradeError.status >= 400 && gradeError.status < 500
        return apiError(
          unreadable ? ApiErrorCode.VALIDATION_FAILED : ApiErrorCode.UPSTREAM_ERROR,
          unreadable ? 'This quiz could not be graded.' : 'Grading failed. Please try again.',
          undefined,
          unreadable ? 422 : 502
        )
      }
      if (!(gradeError instanceof GradingUnavailableError)) throw gradeError
      // Grade now whatever rules can (multiple choice, true or false, numerical): those results and their evidence are
      // the student's at once, and only the short answers wait (spec 18.9). No overall score until all are graded.
      const early = await gradeRuleItemsNow({
        userId: session.user.id,
        topic,
        quizSetId,
        questions,
        given,
        unavailableCode: gradeError.code,
        timeZone,
        sameDayRepeat,
      })
      if (early) {
        return NextResponse.json(
          {
            status: 'partial',
            submissionId: early.submission.submissionId,
            jobId: early.submission.jobId,
            started: early.submission.started,
            code: gradeError.code,
            partial: partialQuizOf(questions, early.ruleGraded, given),
          },
          { status: 202 }
        )
      }
      // Short answers need the model and it cannot be reached. The answers are the student's work:
      // they are stored whole and graded when the AI is back (the same wait exam grading has), and
      // the page says so. Nothing about the quiz touches mastery until it is graded in full.
      const queued = await queueQuizSubmission({
        userId: session.user.id,
        topic,
        quizSetId,
        questions,
        answers: answersForStorage(given),
      })
      return NextResponse.json(
        {
          status: 'waiting',
          submissionId: queued.submissionId,
          jobId: queued.jobId,
          started: queued.started,
          code: gradeError.code,
        },
        { status: 202 }
      )
    }

    const score = graded.overall_score
    const results = toStoredResults(graded.graded_questions, dontKnowIndexes(given))
    const evidence = {
      userId: session.user.id,
      projectId: topic.projectId,
      topicId,
      quizSetId,
      questions,
      answers: given,
      graded: graded.graded_questions,
      sameDayRepeat,
    }
    const recorded = await recordQuizAttempt({
      userId: session.user.id,
      topic,
      quizSetId,
      answers,
      results: results as unknown as Prisma.InputJsonValue,
      score,
      // Kept with the attempt until the evidence below is written, so a failure there is tried again.
      evidencePending: pendingQuizEvidence(evidence),
      strongStart: isStrongStart(graded.graded_questions, given, sameDayRepeat),
    })
    await recordAttemptEvidence({ ...evidence, attemptId: recorded.attempt.id, timeZone })
    // Read once the evidence is written: the figures are the ones every other screen shows (topic-standing.ts).
    const outcome = await quizOutcome(session.user.id, topicId, recorded.previousMastery)
    const review = buildReview(questions, results, answers)
    // Where to look for the questions that were missed, from stored claims (works with the AI down).
    const help = await quizHelp(session.user.id, topicId, questions, review)

    return NextResponse.json({
      status: 'graded',
      attempt: {
        id: recorded.attempt.id,
        score: recorded.attempt.score,
        takenAt: recorded.attempt.takenAt,
      },
      bestScore: recorded.bestScore,
      score,
      earnedPoints: graded.earned_points,
      totalPoints: graded.total_points,
      // The answer key is released here, after grading.
      review,
      ...(help ?? {}),
      // Confidence stays with the student's session and this response, to order the results (spec §5.7).
      confidence: confidences(given),
      // What the attempt changed, so the results can say it: when the topic is next reviewed and how mastery moved.
      outcome,
    })
  } catch (error) {
    logServerError('Save quiz attempt error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to save quiz attempt' },
      { status: 500 }
    )
  }
}

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params
    const { searchParams } = new URL(request.url)
    const rawQuizSetId = searchParams.get('quizSetId')
    const quizSetFilter = rawQuizSetId
      ? rawQuizSetId === 'legacy'
        ? { quizSetId: null as null }
        : { quizSetId: rawQuizSetId }
      : {}

    // Verify topic ownership
    const topic = await ownedTopic(session.user.id, topicId)

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    // Fetch quiz attempts (most recent first). Fallback keeps older DBs working.
    let attempts: Array<{
      id: string
      score: number
      takenAt: Date
      quizSetId: string | null
      answers: Prisma.JsonValue
      results: Prisma.JsonValue
    }>

    try {
      attempts = await prisma.quizAttempt.findMany({
        where: {
          topicId,
          userId: session.user.id,
          ...quizSetFilter,
        },
        orderBy: {
          takenAt: 'desc',
        },
        select: {
          id: true,
          score: true,
          takenAt: true,
          quizSetId: true,
          answers: true,
          results: true,
        },
      })
    } catch (fetchError) {
      if (!isMissingQuizSetColumnError(fetchError)) {
        throw fetchError
      }

      attempts = await prisma.quizAttempt.findMany({
        where: {
          topicId,
          userId: session.user.id,
        },
        orderBy: {
          takenAt: 'desc',
        },
        select: {
          id: true,
          score: true,
          takenAt: true,
          answers: true,
          results: true,
        },
      }).then((rows) =>
        rows.map((row) => ({
          ...row,
          quizSetId: null,
        }))
      )
    }

    // Calculate statistics
    const bestScore = attempts.length > 0
      ? Math.max(...attempts.map(a => a.score))
      : null

    const latestScore = attempts.length > 0 ? attempts[0].score : null

    const averageScore = attempts.length > 0
      ? attempts.reduce((sum, a) => sum + a.score, 0) / attempts.length
      : null

    // Past attempts are already graded, so the review (answer key included) can be sent.
    // The history list shows the five most recent, so only those carry one.
    const questionSets = await loadAllQuizQuestionSets(topic)
    const attemptsWithReview = attempts.map((attempt, index) => {
      const questions = questionSets.get(attempt.quizSetId ?? null)
      return {
        ...attempt,
        review: index < 5 && questions ? buildReview(questions, attempt.results, plainAnswers(normalizeAnswers(attempt.answers))) : null,
      }
    })

    return NextResponse.json({
      attempts: attemptsWithReview,
      stats: {
        totalAttempts: attempts.length,
        bestScore,
        latestScore,
        averageScore,
      },
    })
  } catch (error) {
    logServerError('Fetch quiz attempts error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch quiz attempts' },
      { status: 500 }
    )
  }
}

export const POST = withClientSignal(handlePOST)
