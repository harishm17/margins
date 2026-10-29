import { MIN_PART_MINUTES, type Plan, type PlanItem } from './plan'
import { minutesLabel } from './plan-settings'

/** A plan item in the words, button and link the UI shows. */
export type DescribedPlanItem = {
  id: string
  kind: PlanItem['kind']
  /** The topic it is about, when it is about one. */
  topicId: string | null
  /** "Learn Sorting algorithms". */
  title: string
  /** One plain sentence on why or what. */
  reason: string
  /** The button label: Start, Take quiz, Review... */
  verb: string
  href: string
  /** "About 35 min". */
  etaLabel: string
  minutes: number
  done: boolean
  /** "Part 1 of 2", or null. */
  partLabel: string | null
  /** A full mock exam longer than its day: "Longer than your usual 45 minutes", or null. */
  overBudgetLabel: string | null
}

const eta = (minutes: number) => `About ${minutes} min`

/** Where a plan item leads: the topic, its quiz, the review list or the mock exam form. */
export function planItemHref(item: PlanItem, courseId: string): string {
  const base = `/courses/${courseId}`
  switch (item.kind) {
    case 'learn':
      return item.topicId ? `${base}/topics/${item.topicId}` : `${base}/topics`
    case 'quiz':
      return item.topicId ? `${base}/topics/${item.topicId}?view=quiz` : `${base}/topics`
    case 'review':
      // A projected review has no review date yet, so it is not on the Review list: it is a quiz on the topic.
      if (item.projected && item.topicId) return `${base}/topics/${item.topicId}?view=quiz`
      return item.topicId ? `${base}/review#review-${item.topicId}` : `${base}/review`
    case 'mixed':
      return item.topicIds.length > 0 ? `${base}/exams/new?topics=${item.topicIds.join(',')}` : `${base}/exams/new`
    case 'unit_mock':
      return item.topicIds.length > 0 ? `${base}/exams/new?topics=${item.topicIds.join(',')}` : `${base}/exams/new`
    case 'full_mock':
      return item.topicIds.length > 0 ? `${base}/exams/new?topics=all` : `${base}/exams`
  }
}

/** Names the copy can use, so a row says more than "Read the notes", and the plan's daily minutes. */
export type DescribeContext = { unitTitles?: Record<string, string>; dailyMinutes?: number }

/**
 * Why a mock exam is marked as longer than its day: longer than the daily minutes, or (today, after
 * other work is done) longer than the time that is left.
 */
export function overBudgetLabel(item: Pick<PlanItem, 'overBudget' | 'minutes'>, dailyMinutes?: number): string | null {
  if (!item.overBudget) return null
  if (dailyMinutes === undefined) return 'Longer than your usual study time'
  return item.minutes > dailyMinutes ? `Longer than your usual ${minutesLabel(dailyMinutes)}` : 'Longer than the time left today'
}

const percent = (mastery: number) => `${Math.round(mastery * 100)}%`

/** What a review row says: when it was due and how the topic stands, so five rows do not read the same. */
function reviewReason(item: PlanItem): string {
  const late = /^Overdue by (\d+) days?$/.exec(item.note ?? '')
  const mastery = typeof item.mastery === 'number' ? `mastery ${percent(item.mastery)}` : null
  if (late) {
    const days = Number(late[1])
    const when = days === 1 ? 'Due yesterday' : `Due ${days} days ago`
    return mastery ? `${when}, ${mastery}.` : `${when}.`
  }
  if (item.note === 'One of your weakest topics') return mastery ? `One of your weakest topics, ${mastery}.` : 'One of your weakest topics.'
  if (item.note) return item.note
  if (item.projected) return mastery ? `A short check before it fades, ${mastery}.` : 'A spaced review, timed to keep it fresh.'
  return mastery ? `Due for review, ${mastery}.` : 'Due for review.'
}

export function describePlanItem(item: PlanItem, courseId: string, context: DescribeContext = {}): DescribedPlanItem {
  const common = {
    id: item.id,
    kind: item.kind,
    topicId: item.topicId,
    title: item.title,
    href: planItemHref(item, courseId),
    etaLabel: eta(item.minutes),
    minutes: item.minutes,
    done: item.done,
    partLabel: item.part ? `Part ${item.part.number} of ${item.part.of}` : null,
    overBudgetLabel: overBudgetLabel(item, context.dailyMinutes),
  }
  switch (item.kind) {
    case 'learn': {
      const unit = item.unitId ? context.unitTitles?.[item.unitId] : undefined
      let reason = unit ? `${unit}: read the notes, then work through the examples.` : 'Read the notes, then work through the examples.'
      if (item.part && item.part.number > 1) reason = 'Pick up where you stopped.'
      else if (item.note === 'On past exams') reason = 'This topic is on your past exams.'
      else if (item.note === 'You have started this one') reason = 'You have started this one. Finish the notes and the examples.'
      return { ...common, reason, verb: item.note === 'You have started this one' ? 'Continue' : 'Start' }
    }
    case 'quiz':
      return {
        ...common,
        reason: 'Your first quiz on this topic. It sets your mastery and when you review it next.',
        verb: 'Take quiz',
      }
    case 'review':
      return { ...common, reason: reviewReason(item), verb: 'Review' }
    case 'mixed':
      return { ...common, reason: 'Questions from a few topics mixed together, to find what is still shaky.', verb: 'Create' }
    case 'unit_mock':
      return { ...common, reason: 'Timed questions on the whole unit, now that you have learned it.', verb: 'Create' }
    case 'full_mock':
      return {
        ...common,
        reason: item.note ?? 'Timed, mixed-topic practice on the whole course.',
        verb: item.done ? 'View' : 'Create',
      }
  }
}

/** "Wednesday, Oct 21" style labels need the browser's locale; this gives a stable weekday name for tests and the server. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "Wed, Oct 21" for a YYYY-MM-DD day; no time zone is involved (the day is already local). */
export function dayLabel(day: string, options: { long?: boolean } = {}): string {
  const [year, month, date] = day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()]
  return `${options.long ? weekday : weekday.slice(0, 3)}, ${MONTHS[month - 1]} ${date}`
}

/** A closed day's line: "Learn Sorting", or "Quiz: Sorting and 2 more tasks" (the count is of tasks, not topics). */
export function daySummary(titles: string[]): string {
  if (titles.length === 0) return 'Nothing planned'
  if (titles.length === 1) return titles[0]
  const more = titles.length - 1
  return `${titles[0]} and ${more} more ${more === 1 ? 'task' : 'tasks'}`
}

/** Why the too-long topics are not in the plan. */
export const tooLongText = (dailyMinutes: number): string =>
  `These do not fit in ${minutesLabel(dailyMinutes)} a day, even split into parts of at least ${MIN_PART_MINUTES} minutes. Add study time to fit them.`

/** The notice for reviews that found no day with room before the exam. */
export function reviewsNotScheduledText(names: string[]): string {
  const list = names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `No room before your exam to review ${list}. Add study time to fit ${names.length === 1 ? 'it' : 'them'} in.`
}

/** "Oct 19 to Oct 25" for a week starting on `start`. */
export function weekLabel(start: string): string {
  const [year, month, date] = start.split('-').map(Number)
  const end = new Date(Date.UTC(year, month - 1, date + 6))
  const first = `${MONTHS[month - 1]} ${date}`
  const last = `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`
  return `${first} to ${last}`
}

/** What the overview's "Up next" card shows from today's items of the plan. */
export type UpNextData = {
  /** Items still to do today, in order. */
  upNext: DescribedPlanItem[]
  /** Items finished today. */
  doneToday: DescribedPlanItem[]
  /** Nothing is left for today: the first thing on the next day with work, if any. */
  later: { date: string; item: DescribedPlanItem } | null
}

export function upNextFromPlan(plan: Plan, courseId: string): UpNextData {
  const today = plan.days.find((day) => day.isToday)
  const context: DescribeContext = { dailyMinutes: plan.dailyMinutes }
  const described = (today?.items ?? []).map((item) => describePlanItem(item, courseId, context))
  const upNext = described.filter((item) => !item.done)
  const next = upNext.length === 0 ? plan.days.find((day) => !day.isToday && day.items.some((item) => !item.done)) : null
  const first = next?.items.find((item) => !item.done)
  return {
    upNext,
    doneToday: described.filter((item) => item.done),
    later: next && first ? { date: next.date, item: describePlanItem(first, courseId, context) } : null,
  }
}
