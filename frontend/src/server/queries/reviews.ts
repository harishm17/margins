import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import { topicStandings } from '@/lib/learning/topic-standing'
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
  const now = new Date()
  const boundary = dueBoundary(now, timeZone).getTime()
  // Which topics have a schedule at all is the stored row's; when each is due and its mastery are the figures
  // every screen shows (topic-standing.ts).
  const rows = await prisma.reviewSchedule.findMany({
    where: { userId, project: { userId }, topic: { userConfirmed: true } },
    // Course by course, each in course order: topics due at one moment (a blank exam marks them all) keep it.
    orderBy: [{ project: { createdAt: 'asc' } }, { topic: { orderIndex: 'asc' } }],
    select: { topicId: true, topic: { select: { name: true } }, project: { select: { id: true, name: true } } },
  })
  const standings = await topicStandings(userId, rows.map((row) => row.topicId), now)
  const due = rows
    .flatMap((row) => {
      const standing = standings.get(row.topicId)
      return standing?.dueAt && standing.dueAt.getTime() < boundary ? [{ row, dueAt: standing.dueAt, mastery: standing.mastery }] : []
    })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
  return {
    total: due.length,
    items: due.slice(0, limit).map(({ row, dueAt, mastery }) => ({
      topicId: row.topicId,
      topicName: row.topic.name,
      courseId: row.project.id,
      courseName: row.project.name,
      dueAt: dueAt.toISOString(),
      mastery: mastery ?? 0,
    })),
  }
}
