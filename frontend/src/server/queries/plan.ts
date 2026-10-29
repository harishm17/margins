import { prisma } from '@/lib/db/prisma'
import { examTitle } from '@/lib/exams/display'
import { addDays, buildPlan, localDay, type DoneToday, type Plan, type PlanTopic, type PlanUnit } from '@/lib/learning/plan'
import { zonedTimeToUtc } from '@/lib/learning/study-plan-time'
import { getCourseShell, type CourseShell } from '@/server/queries/courses'

/**
 * The plan of a course, from the student's real state: what they have learned, quizzed and reviewed,
 * the review schedule, the mock exams they took, and what they finished today. The planning itself is
 * lib/learning/plan.ts (pure); this only reads the rows it needs and shapes them.
 */

/** A mock exam that covers at least this share of the course counts as a full mock exam. */
export const FULL_MOCK_COVERAGE = 0.8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The topic ids an exam asks about, from its stored questions. */
export function examTopicIds(questions: unknown): Set<string> {
  const ids = new Set<string>()
  if (Array.isArray(questions)) {
    for (const question of questions) {
      if (isRecord(question) && typeof question.topic_id === 'string') ids.add(question.topic_id)
    }
  }
  return ids
}

export type MockExamFacts = { examId: string; name: string; day: string; topicIds: Set<string> }

/** Units whose topics a mock exam covered completely (a unit with no topics has no mock to take). */
export function unitsCovered(units: PlanUnit[], topics: PlanTopic[], exams: MockExamFacts[]): string[] {
  return units
    .filter((unit) => {
      const members = topics.filter((topic) => topic.unitId === unit.id)
      return members.length > 0 && exams.some((exam) => members.every((topic) => exam.topicIds.has(topic.id)))
    })
    .map((unit) => unit.id)
}

/** Full mock exams (covering most of the course) taken on or after `since` (a YYYY-MM-DD day). */
export function fullMocksSince(exams: MockExamFacts[], topicCount: number, since: string): number {
  return exams.filter((exam) => exam.day >= since && topicCount > 0 && exam.topicIds.size >= topicCount * FULL_MOCK_COVERAGE).length
}

/**
 * The minutes a submitted mock exam took, credited against today's time: from its start to its
 * submission, never more than its time limit. Attempts from before start times were recorded count
 * as the time limit.
 */
export function mockMinutesSpent(attempt: { startedAt: Date | null; submittedAt: Date; durationMinutes: number }): number {
  const limit = Math.max(0, attempt.durationMinutes)
  if (!attempt.startedAt) return limit
  const taken = Math.ceil((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 60_000)
  return Math.max(0, Math.min(limit, taken))
}

export type PlanData = {
  course: CourseShell
  plan: Plan
  timeZone: string
  /** Topics on past exams, for the small tag. */
  examRelevantIds: string[]
}

export async function getPlanData(
  userId: string,
  courseId: string,
  timeZone: string,
  now: Date = new Date()
): Promise<PlanData | null> {
  const course = await getCourseShell(userId, courseId)
  if (!course) return null

  const fresh = course

  const confirmed = fresh.topics.filter((topic) => topic.confirmed)
  const today = localDay(now, timeZone)
  const [year, month, day] = today.split('-').map(Number)
  const startOfToday = zonedTimeToUtc({ year, month, day }, 0, 0, timeZone)

  const [extras, attemptCounts, attemptsToday, submissions] = await Promise.all([
    prisma.topic.findMany({
      where: { projectId: courseId, project: { userId }, userConfirmed: true },
      select: {
        id: true,
        prerequisiteIds: true,
        estimatedMinutes: true,
        examRelevant: true,
        progress: { where: { userId }, take: 1, select: { lastAccessedAt: true } },
        reviewSchedules: { where: { userId }, take: 1, select: { dueAt: true } },
      },
    }),
    prisma.quizAttempt.groupBy({
      by: ['topicId'],
      where: { userId, topic: { projectId: courseId } },
      _count: { _all: true },
    }),
    prisma.quizAttempt.findMany({
      where: { userId, topic: { projectId: courseId }, takenAt: { gte: startOfToday } },
      select: { topicId: true },
    }),
    prisma.examSubmission.findMany({
      where: { userId, status: 'submitted', sampleExam: { projectId: courseId, project: { userId } } },
      orderBy: { submittedAt: 'desc' },
      take: 40,
      select: {
        submittedAt: true,
        startedAt: true,
        sampleExam: { select: { id: true, name: true, createdAt: true, questions: true, durationMinutes: true } },
      },
    }),
  ])

  const extraById = new Map(extras.map((row) => [row.id, row]))
  const attemptTotal = new Map(attemptCounts.map((row) => [row.topicId, row._count._all]))
  const attemptedToday = new Set(attemptsToday.map((row) => row.topicId))
  const attemptTodayCount = new Map<string, number>()
  for (const row of attemptsToday) attemptTodayCount.set(row.topicId, (attemptTodayCount.get(row.topicId) ?? 0) + 1)

  const topics: PlanTopic[] = confirmed.map((topic) => {
    const extra = extraById.get(topic.id)
    const learned = topic.progress.notes && topic.progress.examples
    const accessedToday = extra?.progress[0]?.lastAccessedAt ? localDay(extra.progress[0].lastAccessedAt, timeZone) === today : false
    return {
      id: topic.id,
      name: topic.name,
      unitId: topic.unitId,
      orderIndex: topic.orderIndex,
      prerequisiteIds: extra?.prerequisiteIds ?? [],
      estimatedMinutes: extra?.estimatedMinutes ?? null,
      examRelevant: extra?.examRelevant ?? false,
      learned,
      started: topic.progress.notes || topic.progress.examples,
      quizzed: topic.progress.quiz,
      mastery: topic.mastery,
      reviewDueAt: topic.dueAt ? new Date(topic.dueAt) : null,
      // Finished today: touched today, and not just by a quiz that came after learning it earlier.
      learnedToday: learned && accessedToday && !attemptedToday.has(topic.id),
    }
  })
  const units: PlanUnit[] = fresh.units.map((unit) => ({ id: unit.id, title: unit.title, weekLabel: unit.weekLabel, orderIndex: unit.orderIndex }))

  const seen = new Set<string>()
  const exams: MockExamFacts[] = []
  const doneToday: DoneToday[] = []
  for (const submission of submissions) {
    const exam = submission.sampleExam
    const facts: MockExamFacts = {
      examId: exam.id,
      name: examTitle(exam.name, exam.createdAt),
      day: localDay(submission.submittedAt, timeZone),
      topicIds: examTopicIds(exam.questions),
    }
    if (!seen.has(exam.id)) {
      seen.add(exam.id)
      exams.push(facts)
    }
    if (facts.day === today) {
      const minutes = mockMinutesSpent({ startedAt: submission.startedAt, submittedAt: submission.submittedAt, durationMinutes: exam.durationMinutes })
      doneToday.push({ kind: 'mock', examId: exam.id, name: facts.name, minutes })
    }
  }

  for (const topic of topics) {
    if (topic.learnedToday) doneToday.push({ kind: 'learn', topicId: topic.id })
    const todayCount = attemptTodayCount.get(topic.id) ?? 0
    if (todayCount > 0) {
      // The first quiz ever is "the quiz"; later ones are reviews.
      const before = (attemptTotal.get(topic.id) ?? 0) - todayCount
      doneToday.push({ kind: before > 0 ? 'review' : 'quiz', topicId: topic.id })
    }
  }

  const examDate = fresh.examDate
  const plan = buildPlan({
    now,
    timeZone,
    examDate,
    dailyMinutes: fresh.dailyMinutes,
    topics,
    units,
    unitMocksDone: unitsCovered(units, topics, exams),
    fullMocksDoneInFinalWeek: examDate ? fullMocksSince(exams, topics.length, addDays(examDate, -6)) : 0,
    doneToday,
  })

  return { course: fresh, plan, timeZone, examRelevantIds: topics.filter((topic) => topic.examRelevant).map((topic) => topic.id) }
}
