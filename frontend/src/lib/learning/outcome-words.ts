/**
 * The words for how one answer went, so the same result reads the same on every screen. "I don't know" is a fine answer
 * (spec 18.3), so it never gets the word or the colour of a mistake: it reads "Here's what to learn" (or "To learn" where
 * space is tight) in a neutral tone. Pure.
 */

export type Outcome = {
  /** The answer was fully right. */
  correct?: boolean
  /** Some of the answer was right. */
  partly?: boolean
  /** The student chose "I don't know" (or typed it): no answer on purpose. */
  idk?: boolean
}

export type OutcomeTone = 'accent' | 'warning' | 'danger' | 'neutral'

/** `short` is for badges and rows, where "Right" and "To learn" fit better than the full words. */
export function outcomeLabel(outcome: Outcome, form: 'full' | 'short' = 'full'): string {
  if (outcome.idk) return form === 'short' ? 'To learn' : "Here's what to learn"
  if (outcome.correct) return form === 'short' ? 'Right' : 'Correct'
  if (outcome.partly) return 'Partly'
  return 'Not quite'
}

/** An "I don't know" is neutral, never the red of a wrong answer. */
export function outcomeTone(outcome: Outcome): OutcomeTone {
  if (outcome.idk) return 'neutral'
  if (outcome.correct) return 'accent'
  if (outcome.partly) return 'warning'
  return 'danger'
}
