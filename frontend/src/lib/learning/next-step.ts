import { readyToStudy, type CourseSetup } from '../course-setup'
import { addDays, daysBetween, localDay, REVIEW_MINUTES, type Plan } from './plan'
import { dayLabel, upNextFromPlan, type DescribedPlanItem } from './plan-copy'
import { zonedTimeToUtc } from './study-plan-time'

/**
 * What to do next, in one place. The home page's Continue card, the course overview's Up next
 * card, the sidebar badge, the review page's list and the next-actions API all read it, so they can
 * never disagree. It is a pure function over two things: the study plan (lib/learning/plan.ts) and
 * the reviews that are due.
 *
 * "Due" has one meaning everywhere: a review whose date falls before the end of the student's
 * today, in the student's time zone (`dueBoundary`). The plan's own days use the same zone.
 */

/** A topic whose review is due by the end of today. */
export type DueTopic = { topicId: string; name: string; dueAt: string; mastery: number | null }

/** The first instant of the student's tomorrow: a review before it is due. */
export function dueBoundary(now: Date, timeZone: string): Date {
  const today = localDay(now, timeZone)
  const [year, month, day] = addDays(today, 1).split('-').map(Number)
  return zonedTimeToUtc({ year, month, day }, 0, 0, timeZone)
}

/** True when a review's date is before the boundary. A missing or unreadable date is never due. */
export function isReviewDue(dueAt: Date | string | null | undefined, boundary: Date): boolean {
  if (dueAt === null || dueAt === undefined) return false
  const time = new Date(dueAt).getTime()
  return Number.isFinite(time) && time < boundary.getTime()
}

/** Whole calendar days a review is late in the student's zone: 0 when it is due today. */
export function daysOverdue(dueAt: Date | string, now: Date, timeZone: string): number {
  return Math.max(0, daysBetween(localDay(new Date(dueAt), timeZone), localDay(now, timeZone)))
}

/** The due topics, most overdue first. */
export function sortDue<T extends { dueAt: string }>(due: T[]): T[] {
  return [...due].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
}

export type NextStepKind =
  /** The course is still being set up. */
  | 'setup'
  /** There is something left in today's plan. */
  | 'work'
  /** Today's plan is done (or there is none) but reviews are due. */
  | 'reviews_due'
  /** Nothing left today and nothing due. */
  | 'clear'
  | 'exam_passed'
  | 'no_topics'

export type NextStep = {
  kind: NextStepKind
  /** Reviews due by the end of today: the one number every screen shows. */
  dueCount: number
  /** Of those, how many are a day or more late. */
  overdueCount: number
  /** Due reviews that are not in today's plan, waiting behind it. */
  deferredDue: number
  /** The card's heading: "Review Hash tables", "You're done for today". */
  title: string
  /** One plain sentence under it. */
  reason: string
  /** The button, or null when there is nothing to do. `topicId` is the topic it opens, when it opens one. */
  action: { verb: string; href: string; topicId: string | null } | null
  /** "About 10 min", or null. */
  etaLabel: string | null
  /** "Part 1 of 2", or null. */
  partLabel: string | null
  /** More for today after the first item. */
  then: DescribedPlanItem[]
  /** Items finished today. */
  doneToday: number
  /** Minutes left in today's plan. */
  minutesLeft: number
  /** When today is clear: the next day with work. */
  later: { date: string; item: DescribedPlanItem } | null
  /** The exam: "Exam in 3 days", and the plan's warning when time is short. */
  exam: { label: string | null; short: boolean; shortMessage: string | null; notScheduledCount: number }
}

const reviewsAre = (count: number) => (count === 1 ? '1 review is' : `${count} reviews are`)

const examLabel = (plan: Plan): string | null => {
  if (plan.daysToExam === null || plan.daysToExam < 0) return null
  if (plan.daysToExam === 0) return 'Exam today'
  if (plan.daysToExam === 1) return 'Exam tomorrow'
  return `Exam in ${plan.daysToExam} days`
}

const noExam = { label: null, short: false, shortMessage: null, notScheduledCount: 0 } as const

const agoLabel = (days: number) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`)

/** The next step from a plan and the due reviews. */
export function nextStep(input: {
  courseId: string
  plan: Plan
  due: DueTopic[]
  now: Date
  timeZone: string
}): NextStep {
  const { courseId, plan, now, timeZone } = input
  const base = `/courses/${courseId}`
  const due = sortDue(input.due)
  const dueCount = due.length
  const overdueCount = due.filter((topic) => daysOverdue(topic.dueAt, now, timeZone) >= 1).length
  const exam = {
    label: examLabel(plan),
    short: plan.short,
    shortMessage: plan.shortMessage,
    notScheduledCount: plan.notScheduled?.topics.length ?? 0,
  }
  const shared = { dueCount, overdueCount, exam, then: [], doneToday: 0, minutesLeft: 0, later: null, partLabel: null, deferredDue: 0 }

  // The reviews that wait behind a day that is done or has no room.
  const reviewsFirst = (reason: string): NextStep => {
    const first = due[0]
    return {
      ...shared,
      kind: 'reviews_due',
      title: `Review ${first.name}`,
      reason,
      action: { verb: 'Review', href: `${base}/review#review-${first.topicId}`, topicId: first.topicId },
      etaLabel: `About ${REVIEW_MINUTES} min`,
      deferredDue: dueCount,
    }
  }

  if (plan.status === 'no_topics') {
    return {
      ...shared,
      exam: noExam,
      kind: 'no_topics',
      title: 'Confirm your topics',
      reason: 'Your plan starts once you have confirmed the topics in your materials.',
      action: { verb: 'Go to topics', href: `${base}/topics`, topicId: null },
      etaLabel: null,
    }
  }

  if (plan.status === 'exam_passed') {
    if (dueCount > 0) {
      return reviewsFirst(`Your exam date has passed, but ${reviewsAre(dueCount)} still due.`)
    }
    return {
      ...shared,
      kind: 'exam_passed',
      title: 'Your exam date has passed',
      reason: 'Set a new date to plan your days again.',
      action: { verb: 'Change the date', href: `${base}/settings`, topicId: null },
      etaLabel: null,
    }
  }

  const { upNext, doneToday, later } = upNextFromPlan(plan, courseId)
  const [first, ...rest] = upNext
  const minutesLeft = upNext.reduce((sum, item) => sum + item.minutes, 0)

  if (first) {
    // Due reviews with no place in today's plan.
    const planned = new Set(
      (plan.days.find((day) => day.isToday)?.items ?? [])
        .filter((item) => item.kind === 'review' && !item.done)
        .map((item) => item.topicId)
    )
    return {
      ...shared,
      kind: 'work',
      title: first.title,
      reason: first.reason,
      action: { verb: first.verb, href: first.href, topicId: first.topicId },
      etaLabel: first.etaLabel,
      partLabel: first.partLabel,
      then: rest.slice(0, 3),
      doneToday: doneToday.length,
      minutesLeft,
      deferredDue: due.filter((topic) => !planned.has(topic.topicId)).length,
    }
  }

  if (dueCount > 0) {
    const reason =
      dueCount === 1
        ? `Due ${agoLabel(daysOverdue(due[0].dueAt, now, timeZone))}. Today's plan is done, so it is first in tomorrow's.`
        : `${dueCount} reviews are due, most overdue first. Today's plan is done, so the rest are first in tomorrow's.`
    return { ...reviewsFirst(reason), doneToday: doneToday.length }
  }

  return {
    ...shared,
    kind: 'clear',
    title: doneToday.length > 0 ? "You're done for today" : 'Nothing planned for today',
    reason: later
      ? `Next: ${later.item.title}, ${dayLabel(later.date)}.`
      : 'You are all caught up. A mock exam is a good way to find what to look at next.',
    action: later ? null : { verb: 'New mock exam', href: `${base}/exams/new`, topicId: null },
    etaLabel: null,
    doneToday: doneToday.length,
    later,
  }
}

/**
 * The next step of a course. Until setup steps 1 and 2 are done (`readyToStudy`) there is no
 * plan and the step is the setup step. Once they are, the plan says what is next, also in step 3,
 * where its first item is the first topic to learn.
 */
export function nextStepForCourse(input: {
  courseId: string
  setup: CourseSetup
  plan: Plan | null
  due: DueTopic[]
  now: Date
  timeZone: string
}): NextStep {
  const { courseId, setup, plan } = input
  if (!readyToStudy(setup) || !plan) {
    return {
      kind: 'setup',
      dueCount: 0,
      overdueCount: 0,
      deferredDue: 0,
      title: setup.mode === 'setup' ? setup.label : 'Set up this course',
      reason: 'Finish setting up this course to get your study plan.',
      action: { verb: 'Continue', href: `/courses/${courseId}`, topicId: null },
      etaLabel: 'A few minutes',
      partLabel: null,
      then: [],
      doneToday: 0,
      minutesLeft: 0,
      later: null,
      exam: noExam,
    }
  }
  return nextStep({ courseId, plan, due: input.due, now: input.now, timeZone: input.timeZone })
}
