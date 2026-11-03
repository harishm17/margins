/**
 * When the "missing is expected" line shows (spec §18.10). Pure: the clock and the storage come in.
 *
 * The line shows at most once per surface per local day. A first miss on a surface shows it; a summary shows it
 * only when enough was missed, so a good set is not told it was hard.
 */

export const EXPECTED_MISS_SURFACES = [
  'warmup_results',
  'practice_miss',
  'practice_none_solved',
  'recall_idk',
  'recall_gaps',
  'review_summary',
  'quiz_results',
  'progress_early',
] as const

export type ExpectedMissSurface = (typeof EXPECTED_MISS_SURFACES)[number]

export type MissStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The share of items missed above which a summary shows the line. A review or drill summary: half or more
 * (spec §18.10). The quiz line is worded "under 60%", so it shows when more than 40% was missed.
 */
const SUMMARY_MISSED_SHARE: Partial<Record<ExpectedMissSurface, { min: number; inclusive: boolean }>> = {
  review_summary: { min: 0.5, inclusive: true },
  quiz_results: { min: 0.4, inclusive: false },
}

const PREFIX = 'margins:expected-miss:'

const keyFor = (surface: ExpectedMissSurface) => `${PREFIX}${surface}`

/** The learner's local calendar day, as yyyy-mm-dd. */
function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const date = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${date}`
}

function shownToday(surface: ExpectedMissSurface, now: Date, storage: MissStorage): boolean {
  try {
    return storage.getItem(keyFor(surface)) === localDay(now)
  } catch {
    return false
  }
}

/**
 * Whether to show the line now. `summaryMissedShare` (0 to 1) is given by the summary surfaces only; a summary
 * without it never shows the line. Reading does not mark the line as shown: call `markExpectedMissShown` once
 * it is on screen.
 */
export function shouldShowExpectedMiss(
  surface: ExpectedMissSurface,
  now: Date,
  storage: MissStorage,
  summaryMissedShare?: number
): boolean {
  const rule = SUMMARY_MISSED_SHARE[surface]
  if (rule) {
    if (summaryMissedShare === undefined || !Number.isFinite(summaryMissedShare)) return false
    const enough = rule.inclusive ? summaryMissedShare >= rule.min : summaryMissedShare > rule.min
    if (!enough) return false
  }
  return !shownToday(surface, now, storage)
}

export function markExpectedMissShown(surface: ExpectedMissSurface, now: Date, storage: MissStorage): void {
  try {
    storage.setItem(keyFor(surface), localDay(now))
  } catch {
    // Storage can be blocked; the line then shows again, which is harmless.
  }
}
