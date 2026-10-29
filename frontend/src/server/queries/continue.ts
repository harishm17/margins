import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import { nextStepForCourse, type NextStep } from '@/lib/learning/next-step'
import { mostRecentActivity } from '@/features/home/recent-course'
import { dueTopicsOf } from './course'
import { getPlanData } from './plan'

export type ContinueAction = {
  course: { id: string; name: string }
  /** The same next step the course overview and the sidebar show (lib/learning/next-step.ts). */
  step: NextStep
}

/**
 * The course the student studied most recently: the latest of a topic last opened, a quiz
 * taken or a learning signal, across their courses. Falls back to the most recently updated
 * course when they have not studied anything yet.
 */
async function continueCourse(userId: string): Promise<{ id: string; name: string } | null> {
  const [progress, attempt, signal] = await Promise.all([
    prisma.topicProgress.findFirst({
      where: { userId, lastAccessedAt: { not: null }, topic: { project: { userId } } },
      orderBy: { lastAccessedAt: 'desc' },
      select: { lastAccessedAt: true, topic: { select: { projectId: true } } },
    }),
    prisma.quizAttempt.findFirst({
      where: { userId, topic: { project: { userId } } },
      orderBy: { takenAt: 'desc' },
      select: { takenAt: true, topic: { select: { projectId: true } } },
    }),
    prisma.learningSignal.findFirst({
      where: { userId, project: { userId } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, projectId: true },
    }),
  ])

  const recentId = mostRecentActivity([
    { courseId: progress?.topic.projectId ?? '', at: progress?.lastAccessedAt },
    { courseId: attempt?.topic.projectId ?? '', at: attempt?.takenAt },
    { courseId: signal?.projectId ?? '', at: signal?.createdAt },
  ])

  if (recentId) {
    const course = await prisma.project.findFirst({ where: { id: recentId, userId }, select: { id: true, name: true } })
    if (course) return course
  }
  return prisma.project.findFirst({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true },
  })
}

/**
 * The next step of the course the student worked on most recently: the first thing to do today in
 * its plan, or the reviews that are due, or the setup step. Null when the user has no courses.
 */
export async function continueAction(userId: string, timeZone: string): Promise<ContinueAction | null> {
  await applyPendingQuizResults(userId)
  const course = await continueCourse(userId)
  if (!course) return null

  const data = await getPlanData(userId, course.id, timeZone)
  if (!data) return null
  const now = new Date()
  const step = nextStepForCourse({
    courseId: course.id,
    setup: data.course.setup,
    plan: data.plan,
    due: dueTopicsOf(data.course.topics, now, timeZone),
    now,
    timeZone,
  })
  return { course, step }
}
