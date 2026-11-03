import { CONFIDENCE_WORDS, type ConfidenceId } from '@/lib/learning/calibration'
import { daysBetween } from '@/lib/learning/plan'
import type { FocusReason, Progress } from '@/server/queries/progress'

/** Words for the progress panel (spec §10). Plain figures; nothing here praises or scolds. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 26" for a YYYY-MM-DD week, read as written (no time zone shifts it). */
export function weekLabel(week: string): string {
  const [, month, day] = week.split('-').map(Number)
  return `${MONTHS[month - 1]} ${day}`
}

export const percent = (share: number) => `${Math.round(share * 100)}%`

export const CONFIDENCE_NAMES = CONFIDENCE_WORDS

export const FOCUS_REASONS: Record<FocusReason, string> = {
  misconception: 'Your last miss pointed to a specific mix-up.',
  plateau: 'Missed on your last two tries.',
  fading: 'Of what you have learned, this is the idea you are least likely to recall right now.',
}

/** Why an idea is in the week's focus; a mix-up on record is named, as the grader wrote it (the map's panel shows it the same way). */
export function focusReason(item: { reason: FocusReason; misconception: string | null }): string {
  if (item.reason === 'misconception' && item.misconception) return `${FOCUS_REASONS.misconception.replace(/\.$/, '')}: ${item.misconception}`
  return FOCUS_REASONS[item.reason]
}

/** Bins need this many answers before one is quoted in the sentence; fewer is noise. */
const SENTENCE_MIN_BIN = 5

/** One sentence from the most confident bin with enough answers; null when none has. */
export function calibrationSentence(bins: Progress['calibration']['bins']): string | null {
  const bin = [...bins].reverse().find((candidate) => candidate.n >= SENTENCE_MIN_BIN)
  if (!bin) return null
  const who = bin.label === 'guess' ? 'you are guessing' : `you are ${CONFIDENCE_NAMES[bin.label]}`
  return `When ${who}, your average score is ${percent(bin.accuracy)}.`
}

/** "Average score on first tries, by week: week of Oct 19 62%, ..." for the chart's text equivalent. */
export function weeklyDescription(weekly: Progress['weekly']): string {
  return `Average score on first tries, by week: ${weekly.map((row) => `week of ${weekLabel(row.week)} ${percent(row.accuracy)}`).join(', ')}.`
}

/**
 * Points for the sparkline in a width by height box, score 0 to 1 running bottom to top. A week sits where its
 * date puts it, so a week left out for having too few tries leaves a gap.
 */
export function sparklinePoints(weekly: Progress['weekly'], width: number, height: number, pad: number): { x: number; y: number }[] {
  const days = weekly.length > 1 ? daysBetween(weekly[0].week, weekly[weekly.length - 1].week) : 0
  return weekly.map((row) => ({
    x: days === 0 ? width / 2 : pad + (daysBetween(weekly[0].week, row.week) / days) * (width - 2 * pad),
    y: pad + (1 - row.accuracy) * (height - 2 * pad),
  }))
}

/** The line through the points, broken wherever a week is missing between two of them. */
export function sparklinePath(weekly: Progress['weekly'], points: { x: number; y: number }[]): string {
  return points
    .map((point, index) => {
      const joined = index > 0 && daysBetween(weekly[index - 1].week, weekly[index].week) === 7
      const next = index < points.length - 1 && daysBetween(weekly[index].week, weekly[index + 1].week) === 7
      if (!joined && !next) return ''
      return `${joined ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')
}

/** Weeks, counting the first, during which the panel says early weeks are usually low. */
export const EARLY_WEEKS = 4

/** The student is in the first four weeks of answering in this course (spec 18.10). Both weeks are Mondays, as `getProgress` gives them. */
export function isEarlyWeeks(progress: Pick<Progress, 'firstWeekStart' | 'thisWeek'>): boolean {
  return progress.firstWeekStart !== null && daysBetween(progress.firstWeekStart, progress.thisWeek) < EARLY_WEEKS * 7
}
