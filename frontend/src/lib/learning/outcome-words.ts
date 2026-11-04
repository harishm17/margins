/**
 * The words for how an answer went, in one place. "I don't know" is not a wrong answer: nothing was attempted, so it
 * reads "Here's what to learn" (neutral), and "Not quite" is kept for an attempt that missed.
 */
export type Outcome = { correct?: boolean; partly?: boolean; idk?: boolean }

export function outcomeLabel({ correct, partly, idk }: Outcome): string {
  if (idk) return "Here's what to learn"
  if (correct) return 'Correct'
  if (partly) return 'Partly'
  return 'Not quite'
}
