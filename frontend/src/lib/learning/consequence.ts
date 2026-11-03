import { daysBetween, localDay } from './plan'
import { MONTHS, WEEKDAYS } from './plan-copy'

/**
 * Words for what a study action changed (research idea 4: put the consequence next to the control):
 * when the topic comes back for review, and what happened to its mastery. Pure, so both the quiz
 * results and the confidence prompt say it the same way.
 */

const percent = (value: number) => `${Math.round(value * 100)}%`

/** "Next review today", "tomorrow", "Fri" within the week, "Oct 28" after that. Null for no usable date. */
export function nextReviewLabel(dueAt: string | Date | null | undefined, now: Date, timeZone: string): string | null {
  if (dueAt === null || dueAt === undefined) return null
  const due = new Date(dueAt)
  if (!Number.isFinite(due.getTime())) return null
  const today = localDay(now, timeZone)
  const day = localDay(due, timeZone)
  const gap = daysBetween(today, day)
  if (gap <= 0) return 'Next review today'
  if (gap === 1) return 'Next review tomorrow'
  const [year, month, date] = day.split('-').map(Number)
  if (gap < 7) return `Next review ${WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()].slice(0, 3)}`
  return `Next review ${MONTHS[month - 1]} ${date}`
}

/**
 * "Mastery went from 62% to 71%." Null when mastery did not move or has nothing before it: where mastery
 * stands is the topic header's one figure, and saying it again on the same screen only repeats it.
 */
export function masteryChange(before: number | null | undefined, after: number | null | undefined): string | null {
  if (after === null || after === undefined || Number.isNaN(after)) return null
  if (before === null || before === undefined || Number.isNaN(before)) return null
  if (percent(before) === percent(after)) return null
  return `Mastery went from ${percent(before)} to ${percent(after)}.`
}

/** What a quiz (or a confidence rating) changed, as one line: the next review, then the mastery. */
export function studyOutcome(
  input: { nextReviewAt: string | Date | null | undefined; mastery: number | null | undefined; previousMastery: number | null | undefined },
  now: Date,
  timeZone: string
): string | null {
  const parts = [nextReviewLabel(input.nextReviewAt, now, timeZone), masteryChange(input.previousMastery, input.mastery)]
  const text = parts
    .filter((part): part is string => !!part)
    .map((part) => (part.endsWith('.') ? part : `${part}.`))
    .join(' ')
  return text === '' ? null : text
}

/** Why a ring reads lower than the last score: mastery fades while a review is late. Null when it has not faded. */
export function fadeNote(input: { earned: number | null | undefined; shown: number | null | undefined; daysLate: number }): string | null {
  const { earned, shown, daysLate } = input
  if (earned === null || earned === undefined || shown === null || shown === undefined) return null
  if (daysLate < 1 || percent(earned) === percent(shown) || shown >= earned) return null
  return `Showing ${percent(shown)}, faded from ${percent(earned)} because the review is ${daysLate} ${daysLate === 1 ? 'day' : 'days'} late.`
}
