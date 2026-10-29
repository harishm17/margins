import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule, type Db } from './mastery'

/** A quiz is "right" for scheduling the next review at this score (percent). */
export const QUIZ_PASS_SCORE = 70

export type RecordedQuizAttempt = {
  attempt: { id: string; score: number; takenAt: Date }
  /** The topic's best quiz score after this attempt. */
  bestScore: number
  /** What the attempt changed, so the results can say it. */
  outcome: { nextReviewAt: Date; mastery: number; previousMastery: number | null }
}

export type QuizAttemptInput = {
  userId: string
  topic: { id: string; projectId: string }
  quizSetId: string | null
  answers: Record<string, string>
  results: Prisma.InputJsonValue
  score: number
  /** A fixed id, for a quiz that waited for the AI (the submission's own id). */
  id?: string
  /** When the quiz was taken, if not now. */
  takenAt?: Date
}

/**
 * Stores a graded quiz attempt and every effect of it, on `db` (a transaction): the topic's
 * progress and best score, the learning signal, mastery and the next review date. Callers run it
 * in one transaction (recordQuizAttempt, applyQuizSubmission), so the attempt never exists without
 * its effects, and a failure part way leaves nothing behind.
 *
 * Times: the attempt, the learning signal and the topic's last access are stamped with the time the
 * quiz was taken; the review schedule (last reviewed, next due) counts from now, when the student
 * gets the result, so a long wait for the AI does not make the topic due the moment it is graded.
 *
 * Only ever called with a complete grading: a partial score must never reach mastery.
 */
export async function applyQuizAttempt(db: Db, input: QuizAttemptInput): Promise<RecordedQuizAttempt> {
  const { userId, topic, quizSetId, answers, results, score } = input
  const topicId = topic.id
  const takenAt = input.takenAt ?? new Date()

  const attempt = await db.quizAttempt.create({
    data: { id: input.id, userId, topicId, quizSetId, answers, results, score, takenAt },
    select: { id: true, score: true, takenAt: true },
  })

  const progressKey = { topicId_userId: { topicId, userId } }
  const existingProgress = await db.topicProgress.findUnique({ where: progressKey })
  const currentBest = existingProgress?.quizScore
  const bestScore = currentBest === null || currentBest === undefined ? score : Math.max(currentBest, score)
  const lastSeen = existingProgress?.lastAccessedAt
  // A quiz applied late never moves "last accessed" back.
  const lastAccessedAt = lastSeen && lastSeen > takenAt ? lastSeen : takenAt

  await db.topicProgress.upsert({
    where: progressKey,
    update: { quizCompleted: true, quizScore: bestScore, lastAccessedAt },
    create: {
      topicId,
      userId,
      notesCompleted: false,
      examplesCompleted: false,
      quizCompleted: true,
      quizScore: score,
      lastAccessedAt,
    },
  })

  await recordLearningSignal({
    userId,
    projectId: topic.projectId,
    topicId,
    source: 'quiz',
    score: score / 100,
    metadata: { attemptId: attempt.id, quizSetId },
    at: takenAt,
    db,
  })

  const mastery = await computeTopicMastery(userId, topic.projectId, topicId, db)
  const scheduleBefore = await db.reviewSchedule.findUnique({
    where: { userId_topicId: { userId, topicId } },
    select: { mastery: true },
  })
  const schedule = await upsertReviewSchedule({
    userId,
    projectId: topic.projectId,
    topicId,
    mastery: mastery.mastery,
    wasCorrect: score >= QUIZ_PASS_SCORE,
    db,
  })

  return {
    attempt,
    bestScore,
    outcome: { nextReviewAt: schedule.dueAt, mastery: schedule.mastery, previousMastery: scheduleBefore?.mastery ?? null },
  }
}

/** A quiz graded at once: the attempt and all its effects in one transaction. */
export function recordQuizAttempt(input: QuizAttemptInput): Promise<RecordedQuizAttempt> {
  return prisma.$transaction((tx) => applyQuizAttempt(tx, input), { timeout: 20_000 })
}
