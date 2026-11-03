import { areRecordIds } from '@/lib/ids'
import { examTitles } from '@/lib/exams/display'
import { cache } from 'react'
import { prisma } from '@/lib/db/prisma'

export type ExamBasics = { id: string; name: string; courseId: string; createdAt: string }

/** An exam of one of the user's courses, or null. For breadcrumbs and guards. */
export const getExamBasics = cache(
  async (userId: string, courseId: string, examId: string): Promise<ExamBasics | null> => {
    if (!areRecordIds(courseId, examId)) return null
    const exam = await prisma.sampleExam.findFirst({
      where: { id: examId, projectId: courseId, project: { userId } },
      select: { id: true, name: true, projectId: true, createdAt: true },
    })
    return exam
      ? { id: exam.id, name: exam.name, courseId: exam.projectId, createdAt: exam.createdAt.toISOString() }
      : null
  }
)

/** The course an exam belongs to, for the old /exams/:id URLs. */
export async function findExamCourse(userId: string, examId: string): Promise<string | null> {
  if (!areRecordIds(examId)) return null
  const exam = await prisma.sampleExam.findFirst({
    where: { id: examId, project: { userId } },
    select: { projectId: true },
  })
  return exam?.projectId ?? null
}

/**
 * A submitted attempt of one of the user's exams, or null. A layout checks it so an address that
 * names nothing answers 404 before any of the page is sent (a page's own `notFound()` comes too
 * late for that once its loading skeleton has started streaming).
 */
export const getSubmissionBasics = cache(
  async (userId: string, courseId: string, examId: string, submissionId: string): Promise<{ id: string } | null> => {
    if (!areRecordIds(courseId, examId, submissionId)) return null
    return prisma.examSubmission.findFirst({
      where: {
        id: submissionId,
        sampleExamId: examId,
        userId,
        status: 'submitted',
        sampleExam: { projectId: courseId },
      },
      select: { id: true },
    })
  }
)

/**
 * The titles of every exam of a course, no two alike (see `examTitles`). Pages that show one exam
 * look its title up here, so an exam is called the same thing in the list, the lobby and the results.
 */
export const getExamTitles = cache(async (userId: string, courseId: string): Promise<Map<string, string>> => {
  if (!areRecordIds(courseId)) return new Map()
  const exams = await prisma.sampleExam.findMany({
    where: { projectId: courseId, project: { userId } },
    select: { id: true, name: true, createdAt: true, topicsCovered: true },
  })
  return examTitles(exams)
})

/**
 * The mock exam the student is in the middle of in this course (the oldest, when several), or null. A timed attempt
 * whose time ran out while they were away is not in progress any more: the next visit to the exam submits it.
 */
export async function getOpenExamId(userId: string, courseId: string, now: Date = new Date()): Promise<string | null> {
  if (!areRecordIds(courseId)) return null
  const attempt = await prisma.examSubmission.findFirst({
    where: {
      userId,
      status: 'in_progress',
      sampleExam: { projectId: courseId, project: { userId } },
      OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
    },
    orderBy: { startedAt: 'asc' },
    select: { sampleExamId: true },
  })
  return attempt?.sampleExamId ?? null
}
