/**
 * API route for quiz attempts
 * POST /api/topics/[topicId]/quiz-attempts - Save quiz attempt
 * GET /api/topics/[topicId]/quiz-attempts - Get quiz history
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import {
  computeTopicMastery,
  recordLearningSignal,
  upsertReviewSchedule,
} from '@/lib/learning/mastery'
import { gradeAnswers, GradingUnavailableError } from '@/lib/ai-service/grading'
import { loadAllQuizQuestionSets, loadQuizQuestions } from '@/lib/learning/quiz-sets'
import { buildReview, toStoredResults } from '@/lib/learning/quiz-review'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError } from '@/lib/api/errors'

// The client sends answers only. Anything else in the body (a score, per-question
// results) is dropped by zod and never read: the server grades from the stored questions.
const saveQuizAttemptSchema = z.object({
  answers: z.record(z.string().max(5000)), // { questionIndex: answer }
  quizSetId: z.string().optional(),
})

// Each submission can cost model calls for short answers.
const submitLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
    })

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const validation = saveQuizAttemptSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error },
        { status: 400 }
      )
    }

    const rate = submitLimiter.check(session.user.id)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'Too many quiz submissions. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    const quizSetId = validation.data.quizSetId || null
    const questions = await loadQuizQuestions(topicId, quizSetId)
    if (!questions) {
      return NextResponse.json({ error: 'Quiz not found' }, { status: 404 })
    }

    let graded
    try {
      graded = await gradeAnswers(questions, validation.data.answers)
    } catch (gradeError) {
      if (gradeError instanceof GradingUnavailableError) {
        // Nothing is stored and the answers stay on the student's page (the quiz session), so
        // they submit again once grading can run. The code lets the page update the AI status.
        return apiError(ApiErrorCode.UPSTREAM_ERROR, gradeError.message, gradeError.code ? { code: gradeError.code } : undefined, 503)
      }
      throw gradeError
    }

    const score = graded.overall_score
    const results = toStoredResults(graded.graded_questions)
    const answers = validation.data.answers

    // Save quiz attempt. Fallback keeps older DBs (without quiz_set_id) working.
    let attempt: Awaited<ReturnType<typeof prisma.quizAttempt.create>>
    try {
      attempt = await prisma.quizAttempt.create({
        data: {
          userId: session.user.id,
          topicId,
          quizSetId,
          answers,
          results,
          score,
        },
      })
    } catch (createError) {
      if (!isMissingQuizSetColumnError(createError)) {
        throw createError
      }

      attempt = await prisma.quizAttempt.create({
        data: {
          userId: session.user.id,
          topicId,
          answers,
          results,
          score,
        },
      })
    }

    // Update topic progress with best score
    const existingProgress = await prisma.topicProgress.findUnique({
      where: {
        topicId_userId: {
          topicId,
          userId: session.user.id,
        },
      },
    })

    const currentBest = existingProgress?.quizScore
    const bestScore = currentBest === null || currentBest === undefined
      ? score
      : Math.max(currentBest, score)

    await prisma.topicProgress.upsert({
      where: {
        topicId_userId: {
          topicId,
          userId: session.user.id,
        },
      },
      update: {
        quizCompleted: true,
        quizScore: bestScore,
        lastAccessedAt: new Date(),
      },
      create: {
        topicId,
        userId: session.user.id,
        notesCompleted: false,
        examplesCompleted: false,
        quizCompleted: true,
        quizScore: score,
        lastAccessedAt: new Date(),
      },
    })

    await recordLearningSignal({
      userId: session.user.id,
      projectId: topic.projectId,
      topicId,
      source: 'quiz',
      score: score / 100,
      metadata: {
        attemptId: attempt.id,
        quizSetId,
      },
    })

    const mastery = await computeTopicMastery(session.user.id, topic.projectId, topicId)
    const scheduleBefore = await prisma.reviewSchedule.findUnique({
      where: { userId_topicId: { userId: session.user.id, topicId } },
      select: { mastery: true },
    })
    const schedule = await upsertReviewSchedule({
      userId: session.user.id,
      projectId: topic.projectId,
      topicId,
      mastery: mastery.mastery,
      wasCorrect: score >= 70,
    })

    return NextResponse.json({
      attempt: {
        id: attempt.id,
        score: attempt.score,
        takenAt: attempt.takenAt,
      },
      bestScore,
      score,
      earnedPoints: graded.earned_points,
      totalPoints: graded.total_points,
      // The answer key is released here, after grading.
      review: buildReview(questions, results),
      // What the attempt changed, so the results can say it: when the topic is next reviewed and how mastery moved.
      outcome: {
        nextReviewAt: schedule.dueAt,
        mastery: schedule.mastery,
        previousMastery: scheduleBefore?.mastery ?? null,
      },
    })
  } catch (error) {
    console.error('Save quiz attempt error:', error)

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
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
    })

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
    const questionSets = await loadAllQuizQuestionSets(topicId)
    const attemptsWithReview = attempts.map((attempt, index) => {
      const questions = questionSets.get(attempt.quizSetId ?? null)
      return {
        ...attempt,
        review: index < 5 && questions ? buildReview(questions, attempt.results) : null,
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
    console.error('Fetch quiz attempts error:', error)

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
