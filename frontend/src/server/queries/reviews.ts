import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import { displayMastery } from '@/lib/learning/mastery-math'
import { dueBoundary } from '@/lib/learning/next-step'

export type DueReview = {
  topicId: string
  topicName: string
  courseId: string
  courseName: string
  dueAt: string
  mastery: number
}

/**
 * Topics across the user's courses whose review is due by the end of the student's today, most
 * overdue first. `total` counts all of them so the UI can say "and N more".
 */
export async function dueReviews(userId: string, timeZone: string, limit = 5): Promise<{ items: DueReview[]; total: number }> {
  await applyPendingQuizResults(userId)
  const where = { userId, dueAt: { lt: dueBoundary(new Date(), timeZone) }, project: { userId }, topic: { userConfirmed: true } }

  const [rows, total] = await Promise.all([
    prisma.reviewSchedule.findMany({
      where,
      orderBy: { dueAt: 'asc' },
      take: limit,
      select: {
        topicId: true,
        dueAt: true,
        mastery: true,
        intervalDays: true,
        topic: { select: { name: true } },
        project: { select: { id: true, name: true } },
      },
    }),
    prisma.reviewSchedule.count({ where }),
  ])

  const now = Date.now()
  return {
    total,
    items: rows.map((row) => ({
      topicId: row.topicId,
      topicName: row.topic.name,
      courseId: row.project.id,
      courseName: row.project.name,
      dueAt: row.dueAt.toISOString(),
      mastery: displayMastery(row.mastery, row, now) ?? row.mastery,
    })),
  }
}
