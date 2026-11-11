import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { areRecordIds } from '@/lib/ids'
import { prisma } from '@/lib/db/prisma'
import { hasStudyData, rankWeakestTopics } from './voice-rank'

export { describeSprintTopics } from './voice-rank'

export type SprintTopic = { id: string; name: string }

/** The topics a sprint covers, and whether any topic has a quiz score yet (so "weakest" means something). */
export type Sprint = { topics: SprintTopic[]; studied: boolean }

/**
 * The topics a voice sprint on this course covers, weakest first: the selection the question set
 * builder makes when the session is created (voice-rank.ts), read in course order like it, so ties
 * fall the same way. Filtered by the user id, so a course that is not theirs gives an empty list.
 */
export async function getSprintTopics(userId: string, courseId: string): Promise<Sprint> {
  await applyPendingQuizResults(userId)
  if (!areRecordIds(courseId)) return { topics: [], studied: false }
  const topics = await prisma.topic.findMany({
    where: { projectId: courseId, project: { userId }, userConfirmed: true },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      name: true,
      progress: {
        where: { userId },
        take: 1,
        select: { quizScore: true, quizCompleted: true, notesCompleted: true, examplesCompleted: true },
      },
    },
  })

  const rankable = topics.map((topic) => ({ id: topic.id, name: topic.name, progress: topic.progress[0] ?? null }))
  return {
    topics: rankWeakestTopics(rankable).map(({ id, name }) => ({ id, name })),
    studied: hasStudyData(rankable),
  }
}
