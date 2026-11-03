/**
 * Formatting helpers. Dates use Intl with a fixed locale so the server and the browser agree
 * on wording; the time zone is whatever the runtime has, so calendar labels ("Oct 20", "Thu")
 * should be rendered on the client when the zone matters. Relative labels ("2h ago") do not
 * depend on the zone.
 */

const LOCALE = 'en-US'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type DateInput = Date | string | number

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value))

/** "1.2 MB", "640 KB", "12 B". Accepts the string form the API uses for BigInt sizes. */
export function formatBytes(value: number | string | bigint): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const scaled = bytes / 1024 ** exponent
  const text = exponent === 0 || scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1)
  return `${text.replace(/\.0$/, '')} ${units[exponent]}`
}

const dayMonth = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' })
const dayMonthYear = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })
const clock = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' })

/** "Oct 20", or "Oct 20, 2025" when the year is not the current one. */
export function formatDate(value: DateInput, now: DateInput = new Date()): string {
  const date = toDate(value)
  return date.getFullYear() === toDate(now).getFullYear() ? dayMonth.format(date) : dayMonthYear.format(date)
}

/** "3:12 pm". */
export function formatTime(value: DateInput): string {
  return clock.format(toDate(value)).replace(/\s?(AM|PM)$/, (_match, period: string) => ` ${period.toLowerCase()}`)
}

/** "Oct 20, 3:12 pm". */
export const formatDateTime = (value: DateInput, now: DateInput = new Date()): string =>
  `${formatDate(value, now)}, ${formatTime(value)}`

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

/** "just now", "5m ago", "2h ago", "3d ago", then the date. For things in the past. */
export function formatAgo(value: DateInput, now: DateInput = new Date()): string {
  const date = toDate(value)
  const diff = toDate(now).getTime() - date.getTime()
  if (diff < 45_000) return 'just now'
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m ago`
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)}d ago`
  return formatDate(date, now)
}

/** "tomorrow", "in 4 days", "yesterday", "2 hours ago". Works in both directions. */
export function formatRelative(value: DateInput, now: DateInput = new Date()): string {
  const diff = toDate(value).getTime() - toDate(now).getTime()
  const abs = Math.abs(diff)
  if (abs < MINUTE) return 'now'
  if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), 'minute')
  if (abs < DAY) return relative.format(Math.round(diff / HOUR), 'hour')
  return relative.format(Math.round(diff / DAY), 'day')
}

/** A review due by the end of today: "Due today", or "Overdue 2d" once it is a day or more late. */
export function formatDueLabel(dueAt: DateInput, now: DateInput = new Date()): string {
  const lateBy = toDate(now).getTime() - toDate(dueAt).getTime()
  if (lateBy < DAY) return 'Due today'
  return `Overdue ${Math.floor(lateBy / DAY)}d`
}

/** True once a review is a full day or more late. */
export const isOverdue = (dueAt: DateInput, now: DateInput = new Date()): boolean =>
  toDate(now).getTime() - toDate(dueAt).getTime() >= DAY

/** A timer: "41:07", or "1:05:09" past an hour. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Elapsed time on a job row: "4s", "1m 12s". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${(seconds % 60).toString().padStart(2, '0')}s`
}

/** "1 topic", "12 topics". */
export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

/** "Good morning", "Good afternoon" or "Good evening" for an hour 0..23. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export const firstName = (name: string | null | undefined): string | null => {
  const first = name?.trim().split(/\s+/)[0]
  return first || null
}

/** Up to two capital letters for an avatar: "Harish Mahadevan" gives "HM". Falls back to the email. */
export function initials(name: string | null | undefined, email?: string | null): string {
  const source = name?.trim() || email?.split('@')[0] || ''
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]
  return letters.toUpperCase()
}

/**
 * A 0..100 score as "72%", with at most one decimal ("8.7%", never "9%"). The one rule for every
 * score a student sees (lobby, results, lists, rings, badges), so a figure reads the same everywhere.
 */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`
}
