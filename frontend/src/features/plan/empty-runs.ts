/**
 * The plan's days as rows: a day with something on it (or one that is open, like today) is its own row, and a stretch of
 * consecutive days with nothing on them is one row, so a rolling plan with ten empty days reads as one line, not ten.
 */
export type DayRow<T> = { kind: 'day'; day: T } | { kind: 'empty'; days: T[] }

/**
 * `isEmpty` says a day has nothing planned and is not shown open. A run of one stays a plain day (its own "good day to rest"
 * in an exam plan); two or more become one `empty` row.
 */
export function groupEmptyRuns<T>(days: readonly T[], isEmpty: (day: T) => boolean): DayRow<T>[] {
  const rows: DayRow<T>[] = []
  let run: T[] = []
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'day', day: run[0] })
    else if (run.length > 1) rows.push({ kind: 'empty', days: run })
    run = []
  }
  for (const day of days) {
    if (isEmpty(day)) run.push(day)
    else {
      flush()
      rows.push({ kind: 'day', day })
    }
  }
  flush()
  return rows
}
