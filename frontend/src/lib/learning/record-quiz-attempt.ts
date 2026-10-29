import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule } from './mastery'

/** A quiz is "right" for scheduling the next review at this score (percent). */
export const QUIZ_PASS_SCORE = 70

function isMissingQuizSetColumnError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2022') return false
  const column = String(error.meta?.column || '').toLowerCase()
  const message = String(error.message || '').toLowerCase()
  return (
    column.includes('quiz_set_id') ||
    column.includes('quizsetid') ||
    message.includes('quiz_set_id') ||
    message.includes('quizsetid')
  )
}

export type RecordedQuizAttempt = {
  attempt: { id: string; score: number; takenAt: Date }
  /** The topic's best quiz score after this attempt. */
  bestScore: number
  /** What the attempt changed, so the results can say it. */
  outcome: { nextReviewAt: Date; mastery: number; previousMastery: number | null }
}

/**
 * Stores a graded quiz attempt and applies it: the topic's progress and best score, the learning
 * signal, mastery and the next review date. Used for a quiz graded at once and, with the
 * submission's id and time, for a quiz that waited for the AI (see lib/learning/quiz-submissions).
 *
 * Only ever called with a complete grading: a partial score must never reach mastery.
 * With a fixed `id`, storing the attempt twice keeps the first (the id is the primary key).
 */
export async function recordQuizAttempt(input: {
  userId: string
  topic: { id: string; projectId: string }
  quizSetId: string | null
  answers: Record<string, string>
  results: Prisma.InputJsonValue
  score: number
  id?: string
  takenAt?: Date
}): Promise<RecordedQuizAttempt> {
  const { userId, topic, quizSetId, answers, results, score } = input
  const topicId = topic.id
  const data = { id: input.id, userId, topicId, answers, results, score, takenAt: input.takenAt }

  let attempt: { id: string; score: number; takenAt: Date }
  try {
    try {
      // Fallback keeps older DBs (without quiz_set_id) working.
      attempt = await prisma.quizAttempt.create({ data: { ...data, quizSetId } })
    } catch (createError) {
      if (!isMissingQuizSetColumnError(createError)) throw createError
      attempt = await prisma.quizAttempt.create({ data })
    }
  } catch (error) {
    // The attempt with this id is already stored (a retry of the same application).
    if (!(input.id && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    attempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: input.id } })
  }

  const progressKey = { topicId_userId: { topicId, userId } }
  const existingProgress = await prisma.topicProgress.findUnique({ where: progressKey })
  const currentBest = existingProgress?.quizScore
  const bestScore = currentBest === null || currentBest === undefined ? score : Math.max(currentBest, score)

  await prisma.topicProgress.upsert({
    where: progressKey,
    update: { quizCompleted: true, quizScore: bestScore, lastAccessedAt: new Date() },
    create: {
      topicId,
      userId,
      notesCompleted: false,
      examplesCompleted: false,
      quizCompleted: true,
      quizScore: score,
      lastAccessedAt: new Date(),
    },
  })

  await recordLearningSignal({
    userId,
    projectId: topic.projectId,
    topicId,
    source: 'quiz',
    score: score / 100,
    metadata: { attemptId: attempt.id, quizSetId },
  })

  const mastery = await computeTopicMastery(userId, topic.projectId, topicId)
  const scheduleBefore = await prisma.reviewSchedule.findUnique({
    where: { userId_topicId: { userId, topicId } },
    select: { mastery: true },
  })
  const schedule = await upsertReviewSchedule({
    userId,
    projectId: topic.projectId,
    topicId,
    mastery: mastery.mastery,
    wasCorrect: score >= QUIZ_PASS_SCORE,
  })

  return {
    attempt,
    bestScore,
    outcome: { nextReviewAt: schedule.dueAt, mastery: schedule.mastery, previousMastery: scheduleBefore?.mastery ?? null },
  }
}
