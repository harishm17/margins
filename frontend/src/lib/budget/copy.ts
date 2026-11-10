/**
 * What students are told when they have used the day's AI allowance. No dollar amounts ever
 * reach the page: the AI service keeps those in its logs and in the job's error message, and
 * the screens show this copy for the code LLM_DAILY_BUDGET instead.
 *
 * The allowance resets at midnight UTC. The time is shown in the student's own time zone, so it
 * is worked out in the browser. Text produced on the server (it cannot know the time zone) carries
 * RESET_TOKEN where the time goes; `fillResetTime` swaps it in once the text reaches the browser.
 */

export const RESET_TOKEN = '{reset}'

export const ALLOWANCE_USED = "You've used today's AI allowance."

/** The message as the server writes it: the time is still a token. */
export const ALLOWANCE_TEMPLATE = `${ALLOWANCE_USED} It resets ${RESET_TOKEN}.`

/** The next midnight UTC after `now`. */
export function nextResetUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

/**
 * "at 5:00 PM", or "tomorrow at 8:00 AM" when the reset falls on the next calendar day in the
 * given time zone (the browser's by default).
 */
export function resetPhrase(now: Date = new Date(), timeZone?: string): string {
  const reset = nextResetUtc(now)
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(reset)
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }).format(date)
  return day(reset) === day(now) ? `at ${time}` : `tomorrow at ${time}`
}

/** "You've used today's AI allowance. It resets at 5:00 PM." */
export function allowanceMessage(now: Date = new Date(), timeZone?: string): string {
  return fillResetTime(ALLOWANCE_TEMPLATE, now, timeZone)
}

/** Put the local reset time where a server-written message has RESET_TOKEN. */
export function fillResetTime(message: string, now: Date = new Date(), timeZone?: string): string {
  return message.includes(RESET_TOKEN) ? message.replace(RESET_TOKEN, resetPhrase(now, timeZone)) : message
}

/**
 * Why a student cannot use AI right now when it is not simply "today's allowance is used", in plain words. A new account
 * has a smaller allowance on its first day, and new accounts pause when the whole service is nearly at its daily cap, so
 * what is left goes to people who have been here longer. Both come back at the reset. Null for the ordinary case.
 */
export function refusalNote(refused: 'user' | 'first_day' | 'reserve' | 'global' | null, resets: string): string | null {
  if (refused === 'first_day') {
    return `Your first-day allowance is used. New accounts start with a smaller allowance for their first day, and it resets ${resets}.`
  }
  if (refused === 'reserve') {
    return `New accounts are paused for the rest of today. Margins is close to its daily limit and is keeping what is left for people who have been here longer. It resets ${resets}.`
  }
  return null
}

/** The heading that goes with `refusalNote` (a paused new account has not used its allowance), or null for the ordinary case. */
export function refusalTitle(refused: 'user' | 'first_day' | 'reserve' | 'global' | null): string | null {
  if (refused === 'first_day') return "You've used today's first-day allowance"
  if (refused === 'reserve') return 'New accounts are paused for today'
  return null
}
