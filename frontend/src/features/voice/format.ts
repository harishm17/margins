/** "18 min left today", "Under 1 min left today", "0 min left today". */
export function minutesLeftLabel(remainingSeconds: number): string {
  const seconds = Math.max(0, Math.floor(remainingSeconds))
  if (seconds === 0) return '0 min left today'
  if (seconds < 60) return 'Under 1 min left today'
  return `${Math.floor(seconds / 60)} min left today`
}

/** A session length for the summary: "under a minute", "1 minute", "12 minutes". A session is never rounded up to a minute it did not last. */
export function minutesLabel(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/**
 * The summary's line about the session: "You talked for 3 minutes.", "You typed for 3 minutes and sent 4 messages.".
 * The verb follows how the student answered, so a session of typed answers is not "talked", and a session with no
 * answers at all says so instead of claiming any talking.
 */
export function sessionLine(summary: { seconds: number; exchanges: number; typed: number }, withMessages: boolean): string {
  if (summary.exchanges === 0) return `No answers sent. The session lasted ${minutesLabel(summary.seconds)}.`
  const verb = summary.typed === 0 ? 'talked' : summary.typed >= summary.exchanges ? 'typed' : 'talked and typed'
  const base = `You ${verb} for ${minutesLabel(summary.seconds)}`
  return withMessages ? `${base} and sent ${summary.exchanges} ${summary.exchanges === 1 ? 'message' : 'messages'}.` : `${base}.`
}

/** Cut a long question to one line of the summary list, on a word boundary. */
export function clip(text: string, max = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 3)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}...`
}

const NEUTRAL_FOCUS = 'e.g. the definitions I keep mixing up'
const MAX_FOCUS_EXAMPLE = 40

/**
 * The example in the voice lobby's Focus field: the first of the topic's own key terms that fits
 * the field, or a neutral example that suits any course (a sprint, or a topic with no key terms).
 */
export function focusPlaceholder(keywords: readonly string[] = []): string {
  const keyword = keywords.map((word) => word.replace(/\s+/g, ' ').trim()).find((word) => word.length > 0 && word.length <= MAX_FOCUS_EXAMPLE)
  return keyword ? `e.g. ${keyword}` : NEUTRAL_FOCUS
}
