import { prisma } from '@/lib/db/prisma'
import { Prisma } from '@prisma/client'
import {
  MASTERY_HISTORY,
  computeMasteryFromSignals,
  intervalFromMastery,
  isConfidenceFeedback,
  masteryFromHistory,
  newestPerTopic,
  type MasteryComponents,
} from './mastery-math'

export { computeMasteryFromSignals, intervalFromMastery, isConfidenceFeedback }
export type { MasteryComponents }

/** The database, or the transaction a caller is applying a result in. */
export type Db = Prisma.TransactionClient

export async function computeTopicMastery(
  userId: string,
  projectId: string,
  topicId: string,
  db: Db = prisma
): Promise<MasteryComponents> {
  const masteries = await computeProjectMastery(userId, projectId, [topicId], db)
  return masteries.get(topicId) as MasteryComponents
}

/**
 * Mastery for many topics of one project in three queries, however many topics there are.
 * Each query fetches the user's recent rows for all the topics; the per-topic limits are
 * applied here.
 */
export async function computeProjectMastery(
  userId: string,
  projectId: string,
  topicIds: string[],
  db: Db = prisma
): Promise<Map<string, MasteryComponents>> {
  const result = new Map<string, MasteryComponents>()
  if (topicIds.length === 0) return result

  // One topic can be cut to its history length in SQL. With several, the rows are cut
  // per topic below.
  const limit = (history: number): number | undefined => (topicIds.length === 1 ? history : undefined)

  const [quizAttempts, voiceAttempts, examSignals, practiceSignals] = await Promise.all([
    db.quizAttempt.findMany({
      where: { userId, topicId: { in: topicIds } },
      orderBy: { takenAt: 'desc' },
      take: limit(MASTERY_HISTORY.quiz),
      select: { topicId: true, score: true, takenAt: true },
    }),
    db.voiceDrillAttempt.findMany({
      where: { userId, topicId: { in: topicIds } },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.voice),
      select: { topicId: true, score: true, createdAt: true },
    }),
    db.learningSignal.findMany({
      where: { userId, projectId, topicId: { in: topicIds }, source: 'exam' },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.exam),
      select: { topicId: true, score: true, createdAt: true, metadata: true },
    }),
    db.learningSignal.findMany({
      where: { userId, projectId, topicId: { in: topicIds }, source: 'practice' },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.practice),
      select: { topicId: true, score: true, createdAt: true },
    }),
  ])

  const quizByTopic = newestPerTopic(quizAttempts, MASTERY_HISTORY.quiz)
  const voiceByTopic = newestPerTopic(voiceAttempts, MASTERY_HISTORY.voice)
  const examByTopic = newestPerTopic(examSignals, MASTERY_HISTORY.exam)
  const practiceByTopic = newestPerTopic(practiceSignals, MASTERY_HISTORY.practice)
  const now = Date.now()

  for (const topicId of topicIds) {
    result.set(
      topicId,
      masteryFromHistory({
        quiz: (quizByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.takenAt })),
        voice: (voiceByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.createdAt })),
        exam: (examByTopic.get(topicId) ?? [])
          .filter((row) => !isConfidenceFeedback(row.metadata))
          .map((row) => ({ score: row.score, at: row.createdAt })),
        practice: (practiceByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.createdAt })),
        now,
      })
    )
  }
  return result
}

export async function upsertReviewSchedule(input: {
  userId: string
  projectId: string
  topicId: string
  mastery: number
  wasCorrect?: boolean
  confidence?: number
  db?: Db
}) {
  const { userId, projectId, topicId, mastery, wasCorrect = true, confidence, db = prisma } = input
  const intervalDays = intervalFromMastery(mastery, { wasCorrect, confidence })
  const now = new Date()
  const dueAt = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000)

  const existing = await db.reviewSchedule.findUnique({
    where: {
      userId_topicId: {
        userId,
        topicId,
      },
    },
    select: {
      streak: true,
    },
  })

  return db.reviewSchedule.upsert({
    where: {
      userId_topicId: {
        userId,
        topicId,
      },
    },
    update: {
      projectId,
      mastery,
      dueAt,
      intervalDays,
      streak: wasCorrect ? (existing?.streak || 0) + 1 : 0,
      lastReviewedAt: now,
    },
    create: {
      userId,
      projectId,
      topicId,
      mastery,
      dueAt,
      intervalDays,
      streak: wasCorrect ? 1 : 0,
      lastReviewedAt: now,
    },
  })
}

/**
 * Re-time a topic's next review after the student rates their confidence.
 *
 * Confidence is feedback, not practice: it never touches the streak or the last-reviewed
 * time, and it does not create a schedule for a topic nobody has practised. Low confidence
 * (1-2) brings the review forward to tomorrow; otherwise the usual mastery-based interval
 * applies, one step longer when confidence is high.
 */
export async function adjustReviewForConfidence(input: {
  userId: string
  topicId: string
  mastery: number
  confidence: number
}) {
  const { userId, topicId, mastery, confidence } = input
  const existing = await prisma.reviewSchedule.findUnique({
    where: { userId_topicId: { userId, topicId } },
    select: { lastReviewedAt: true },
  })
  if (!existing) return null

  const intervalDays = confidence <= 2 ? 1 : intervalFromMastery(mastery, { confidence })
  const base = existing.lastReviewedAt ?? new Date()
  return prisma.reviewSchedule.update({
    where: { userId_topicId: { userId, topicId } },
    data: {
      mastery,
      intervalDays,
      dueAt: new Date(base.getTime() + intervalDays * 24 * 60 * 60 * 1000),
    },
  })
}

export async function recordLearningSignal(input: {
  userId: string
  projectId: string
  topicId?: string | null
  source: 'quiz' | 'voice' | 'exam' | 'practice'
  score: number
  confidence?: number
  metadata?: Record<string, unknown>
  /** When it happened, if not now. */
  at?: Date
  db?: Db
}) {
  return (input.db ?? prisma).learningSignal.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId ?? null,
      source: input.source,
      score: input.score,
      confidence: input.confidence ?? null,
      metadata: (input.metadata ?? {}) as Prisma.JsonObject,
      ...(input.at ? { createdAt: input.at } : {}),
    },
  })
}
