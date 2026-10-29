import { areRecordIds } from '@/lib/ids'
import { cache } from 'react'
import { prisma } from '@/lib/db/prisma'
import { deriveSetup, needsTopicReview, type CourseSetup, type ExtractionOutcome } from '@/lib/course-setup'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'
import { applyPendingExamResults } from '@/lib/learning/exam-mastery'
import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { displayMastery } from '@/lib/learning/mastery-math'
import { dueBoundary, isReviewDue } from '@/lib/learning/next-step'
import { masteryLevel, type MasteryLevel } from '@/lib/mastery'

/** Everything here is filtered by the user id; an id that is not theirs is simply not found. */

// ---------------------------------------------------------------------------------------
// Setup state: every loader below builds it the same way (lib/course-setup.ts has the rules).

/** The topic fields setup needs; every loader selects them. */
const SETUP_TOPIC_FIELDS = {
  userConfirmed: true,
  sourceMaterialIds: true,
  _count: { select: { content: true, sources: true } },
} as const

type SetupTopicRow = { userConfirmed: boolean; sourceMaterialIds: string[]; _count: { content: number; sources: number } }

/** A topic found in the files has sources (or, for courses planned before sources existed, source files). */
const isExtracted = (topic: Pick<SetupTopicRow, 'sourceMaterialIds' | '_count'>) =>
  topic._count.sources > 0 || topic.sourceMaterialIds.length > 0

function extractionOutcome(status: string | undefined): ExtractionOutcome {
  if (!status) return 'none'
  if (ACTIVE_JOB_STATUSES.includes(status)) return 'running'
  return status === 'failed' ? 'failed' : 'done'
}

/** The latest topic-finding job of each course, by course id. */
async function latestExtractions(userId: string, courseIds: string[]): Promise<Map<string, ExtractionOutcome>> {
  if (courseIds.length === 0) return new Map()
  const jobs = await prisma.processingJob.findMany({
    where: { userId, jobType: 'extract_topics', projectId: { in: courseIds } },
    orderBy: [{ projectId: 'asc' }, { createdAt: 'desc' }],
    distinct: ['projectId'],
    select: { projectId: true, status: true },
  })
  return new Map(jobs.map((job) => [job.projectId as string, extractionOutcome(job.status)]))
}

function setupOf(
  project: { status: string; _count: { materials: number }; topics: SetupTopicRow[] },
  extraction: ExtractionOutcome
): CourseSetup {
  const extracted = project.topics.filter(isExtracted)
  return deriveSetup({
    status: project.status,
    materialCount: project._count.materials,
    topicCount: project.topics.length,
    confirmedTopicCount: project.topics.filter((topic) => topic.userConfirmed).length,
    extractedTopicCount: extracted.length,
    confirmedExtractedTopicCount: extracted.filter((topic) => topic.userConfirmed).length,
    contentBlockCount: project.topics.reduce((sum, topic) => sum + topic._count.content, 0),
    extraction,
  })
}

export type CourseListItem = {
  id: string
  name: string
  description: string | null
  status: string
  updatedAt: string
  topicCount: number
  strongCount: number
  /** One level per topic in course order, for the mastery strip. */
  levels: MasteryLevel[]
  setup: CourseSetup
}

export async function listCourses(userId: string): Promise<CourseListItem[]> {
  await applyPendingQuizResults(userId)
  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      updatedAt: true,
      _count: { select: { materials: true } },
      topics: {
        orderBy: { orderIndex: 'asc' },
        select: {
          ...SETUP_TOPIC_FIELDS,
          reviewSchedules: { where: { userId }, take: 1, select: { mastery: true, dueAt: true, intervalDays: true } },
        },
      },
    },
  })

  const now = Date.now()
  const extractions = await latestExtractions(userId, projects.map((project) => project.id))
  return projects.map((project) => {
    const setup = setupOf(project, extractions.get(project.id) ?? 'none')
    // New topics waiting for review do not count as part of a confirmed course.
    const shown = project.topics.filter((topic) => !setup.topics.listConfirmed || topic.userConfirmed)
    const levels = shown.map((topic) => masteryLevel(displayMastery(topic.reviewSchedules[0]?.mastery, topic.reviewSchedules[0], now)))
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      updatedAt: project.updatedAt.toISOString(),
      topicCount: shown.length,
      strongCount: levels.filter((level) => level === 'strong').length,
      levels,
      setup,
    }
  })
}

/** The exam date column holds midnight UTC of the calendar date; the date is what matters. */
export const toExamDate = (value: Date | null | undefined): string | null =>
  value ? value.toISOString().slice(0, 10) : null

/** A unit (a week, a chapter, a lecture group). Topics of a flat course have no unit. */
export type ShellUnit = {
  id: string
  title: string
  summary: string | null
  /** "Week 3" or "Class 11" when the syllabus said so. */
  weekLabel: string | null
  orderIndex: number
}

export type ShellTopic = {
  id: string
  name: string
  description: string | null
  orderIndex: number
  /** The unit it belongs to, or null (added by hand, or planned before units existed). */
  unitId: string | null
  confirmed: boolean
  /** 0..1 from the review schedule, faded when the review is overdue; null with no signal yet. */
  mastery: number | null
  /** The mastery the student earned, before any fade for a late review. */
  earnedMastery: number | null
  dueAt: string | null
  progress: { notes: boolean; examples: boolean; quiz: boolean; quizScore: number | null }
  /** The content types that exist: section_notes, solved_examples, interactive_examples, topic_quiz. */
  content: string[]
}

export type CourseShell = {
  id: string
  name: string
  description: string | null
  status: string
  updatedAt: string
  materialCount: number
  setup: CourseSetup
  /** The exam date as YYYY-MM-DD (a calendar date), or null while unknown. */
  examDate: string | null
  /** Minutes the student can study on a day. */
  dailyMinutes: number
  /** The student closed the "When is your exam?" card. */
  examPromptDismissed: boolean
  /** In course order; empty for a flat course. A unit with no topics is included (the editor shows it). */
  units: ShellUnit[]
  topics: ShellTopic[]
}

/** A course with its topics, mastery, progress and content presence. Null when it is not theirs. Applies graded mock exams to mastery first. */
export const getCourseShell = cache(async (userId: string, courseId: string): Promise<CourseShell | null> => {
  if (!areRecordIds(courseId)) return null
  // A graded mock exam (or a quiz that waited for the AI) moves mastery and review dates the first time it is seen (once per grading),
  // so it is applied before mastery is read anywhere on a course page.
  await applyPendingExamResults(userId, courseId)
  // Likewise a quiz that waited for the AI and has been graded since.
  await applyPendingQuizResults(userId)
  const project = await prisma.project.findFirst({
    where: { id: courseId, userId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      updatedAt: true,
      examDate: true,
      dailyMinutes: true,
      examPromptDismissed: true,
      _count: { select: { materials: true } },
      units: {
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, summary: true, weekLabel: true, orderIndex: true },
      },
      topics: {
        orderBy: { orderIndex: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          orderIndex: true,
          unitId: true,
          ...SETUP_TOPIC_FIELDS,
          content: { select: { contentType: true } },
          progress: {
            where: { userId },
            take: 1,
            select: { notesCompleted: true, examplesCompleted: true, quizCompleted: true, quizScore: true },
          },
          reviewSchedules: { where: { userId }, take: 1, select: { mastery: true, dueAt: true, intervalDays: true } },
        },
      },
    },
  })
  if (!project) return null

  const now = Date.now()
  const extraction = (await latestExtractions(userId, [project.id])).get(project.id) ?? 'none'
  const topics: ShellTopic[] = project.topics.map((topic) => {
    const progress = topic.progress[0]
    const schedule = topic.reviewSchedules[0]
    return {
      id: topic.id,
      name: topic.name,
      description: topic.description,
      orderIndex: topic.orderIndex,
      unitId: topic.unitId,
      confirmed: topic.userConfirmed,
      mastery: displayMastery(schedule?.mastery, schedule, now),
      earnedMastery: schedule?.mastery ?? null,
      dueAt: schedule?.dueAt.toISOString() ?? null,
      progress: {
        notes: progress?.notesCompleted ?? false,
        examples: progress?.examplesCompleted ?? false,
        quiz: progress?.quizCompleted ?? false,
        quizScore: progress?.quizScore ?? null,
      },
      content: topic.content.map((item) => item.contentType),
    }
  })

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    updatedAt: project.updatedAt.toISOString(),
    materialCount: project._count.materials,
    examDate: toExamDate(project.examDate),
    dailyMinutes: project.dailyMinutes,
    examPromptDismissed: project.examPromptDismissed,
    setup: setupOf(project, extraction),
    units: project.units,
    topics,
  }
})

export type NavTopic = { id: string; name: string; mastery: number | null; unitId: string | null }
export type NavUnit = { id: string; title: string; weekLabel: string | null; orderIndex: number }
export type NavFile = { id: string; filename: string }

export type NavCourse = {
  id: string
  name: string
  status: string
  updatedAt: string
  /** Confirmed topics whose review is due by the end of the student's today. */
  dueCount: number
  /** Topics exist but the student has not confirmed the list yet: the sidebar shows a dot on "Topics". */
  needsTopicReview: boolean
  /** The course is past setup, so the sidebar lists its topics. */
  active: boolean
  /** In course order; empty for a flat course. */
  units: NavUnit[]
  topics: NavTopic[]
  /** The course's files, newest first, so search finds a file by its name. */
  files: NavFile[]
}

/**
 * What the app shell needs on every page: the user's courses (most recent first) with topic
 * names and mastery, for the sidebar, the course switcher and the command palette.
 */
export const getNavIndex = cache(async (userId: string, timeZone = 'UTC'): Promise<NavCourse[]> => {
  await applyPendingQuizResults(userId)
  const now = new Date()
  const boundary = dueBoundary(now, timeZone)
  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      status: true,
      updatedAt: true,
      _count: { select: { materials: true } },
      units: {
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, weekLabel: true, orderIndex: true },
      },
      materials: {
        orderBy: { uploadedAt: 'desc' },
        select: { id: true, filename: true },
      },
      topics: {
        orderBy: { orderIndex: 'asc' },
        select: {
          id: true,
          name: true,
          unitId: true,
          ...SETUP_TOPIC_FIELDS,
          reviewSchedules: { where: { userId }, take: 1, select: { mastery: true, dueAt: true, intervalDays: true } },
        },
      },
    },
  })

  const extractions = await latestExtractions(userId, projects.map((project) => project.id))
  return projects.map((project) => {
    const setup = setupOf(project, extractions.get(project.id) ?? 'none')
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      updatedAt: project.updatedAt.toISOString(),
      // The same meaning of "due" as the Review page, Home and the overview (lib/learning/next-step.ts).
      dueCount: project.topics.filter((topic) => topic.userConfirmed && isReviewDue(topic.reviewSchedules[0]?.dueAt, boundary)).length,
      needsTopicReview: needsTopicReview(setup),
      active: setup.mode === 'active',
      units: project.units,
      files: project.materials,
      // New topics found after the student confirmed wait for review: the sidebar, the command palette and
      // search list only the confirmed ones.
      topics: project.topics.filter((topic) => !setup.topics.listConfirmed || topic.userConfirmed).map((topic) => ({
        id: topic.id,
        name: topic.name,
        mastery: displayMastery(topic.reviewSchedules[0]?.mastery, topic.reviewSchedules[0], now),
        unitId: topic.unitId,
      })),
    }
  })
})
