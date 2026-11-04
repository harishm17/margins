import { prisma } from '@/lib/db/prisma'
import { parsePracticeProblems } from '@/features/topic/content'
import { PRACTICE_DONE_SHARE } from '@/features/topic/practice-keys'

type PracticeRow = { contentId: string; problemIndex: number; problemTitle: string; stepsSolved: number }
type PracticeContentRow = { id: string; topicId: string; contentData: unknown; updatedAt: Date }

/**
 * The topics whose practice is worked through: at least 80% of the steps of the current problems are solved
 * (the share the topic path uses in the browser). Rows for problems the content has since replaced do not count.
 * Pure, so the Topics list and the next-activity state agree on it.
 */
export function practiceDoneTopics(contents: PracticeContentRow[], rows: PracticeRow[]): Set<string> {
  const done = new Set<string>()
  for (const content of contents) {
    const problems = parsePracticeProblems(content.contentData, content.updatedAt.toISOString())?.items ?? []
    const total = problems.reduce((sum, problem) => sum + problem.steps.length, 0)
    const solved = rows
      .filter((row) => row.contentId === content.id && problems[row.problemIndex]?.title === row.problemTitle)
      .reduce((sum, row) => sum + row.stepsSolved, 0)
    if (total > 0 && solved / total >= PRACTICE_DONE_SHARE) done.add(content.topicId)
  }
  return done
}

/** Whether one topic's practice is written, and whether this student has worked through it. */
export async function loadPracticeState(userId: string, topicId: string): Promise<{ written: boolean; done: boolean }> {
  const [rows, contents] = await Promise.all([
    prisma.practiceProgress.findMany({
      where: { userId, topicId },
      select: { contentId: true, problemIndex: true, problemTitle: true, stepsSolved: true },
    }),
    prisma.topicContent.findMany({
      where: { topicId, contentType: 'interactive_examples' },
      select: { id: true, topicId: true, contentData: true, updatedAt: true },
    }),
  ])
  return { written: contents.length > 0, done: practiceDoneTopics(contents, rows).has(topicId) }
}
