// Time zone arithmetic for the study plan. The server runs in UTC (Cloud Run) but the plan is laid
// out in the student's own days, so the browser sends its IANA time zone (a cookie, or ?tz=) and the
// plan works out which calendar date an instant is in that zone.

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

type LocalParts = { year: number; month: number; day: number }

// Building an Intl.DateTimeFormat costs far more than using one, and replay and the plan ask for the local day of
// every event: one formatter per zone and shape, made on first use.
const formatters = new Map<string, Intl.DateTimeFormat>()
export function dateFormatter(timeZone: string, shape: 'day' | 'clock'): Intl.DateTimeFormat {
  const key = `${shape}|${timeZone}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter =
      shape === 'day'
        ? new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        : new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
    formatters.set(key, formatter)
  }
  return formatter
}

/** The calendar date it is at `instant` in `timeZone`. */
export function localDateParts(instant: Date, timeZone: string): LocalParts {
  const parts = dateFormatter(timeZone, 'day').formatToParts(instant)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = dateFormatter(timeZone, 'clock').formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wallAsUtc - Math.floor(instant / 1000) * 1000
}

/** The UTC instant at which the wall clock in `timeZone` reads the given date and time. */
export function zonedTimeToUtc(
  { year, month, day }: LocalParts,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute)
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone)
  let instant = wallAsUtc - firstOffset
  // Near a daylight-saving change the offset at the result can differ from the first guess.
  const secondOffset = zoneOffsetMs(instant, timeZone)
  if (secondOffset !== firstOffset) instant = wallAsUtc - secondOffset
  return new Date(instant)
}
