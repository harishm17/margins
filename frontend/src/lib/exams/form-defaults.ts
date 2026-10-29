/** What the new mock exam form offers for time and questions, and how a link can preset them. Pure. */

export const QUESTION_COUNTS = [5, 10, 20, 30, 40] as const
/** 15 and 20 are for short sets such as a mixed practice block of the plan (15 to 30 minutes). */
export const TIME_LIMITS = [15, 20, 30, 60, 90, 120, 180] as const
export const DEFAULT_TOTAL_QUESTIONS = 20
export const DEFAULT_DURATION_MINUTES = 60

/** Minutes per question the form's own defaults use (20 questions in 60 minutes). */
const MINUTES_PER_QUESTION = DEFAULT_DURATION_MINUTES / DEFAULT_TOTAL_QUESTIONS

/** The allowed value nearest to `value`; a tie goes to the smaller one (it fits the time the student has). */
function nearest<T extends number>(options: readonly T[], value: number): T {
  return options.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best))
}

/** A whole number from a URL parameter (the first one if repeated), or null for anything else. */
function wholeNumber(raw: string | string[] | undefined): number | null {
  const text = Array.isArray(raw) ? raw[0] : raw
  if (typeof text !== 'string' || !/^\d{1,4}$/.test(text)) return null
  const value = Number(text)
  return value > 0 ? value : null
}

/** About as many questions as the time allows at the form's default pace, as one of the choices. */
export function questionsForMinutes(minutes: number): number {
  return nearest(QUESTION_COUNTS, minutes / MINUTES_PER_QUESTION)
}

/**
 * The time limit and question count the form starts with. A link from the plan passes `minutes` (and
 * may pass `questions`); each is clamped to the choices on the form, junk is ignored, and the
 * student can still change both. Without `minutes` the question count only follows `questions`.
 */
export function examDefaultsFromParams(params: { minutes?: string | string[]; questions?: string | string[] }): {
  durationMinutes: number
  totalQuestions: number
} {
  const minutes = wholeNumber(params.minutes)
  const questions = wholeNumber(params.questions)
  const durationMinutes = minutes === null ? DEFAULT_DURATION_MINUTES : nearest(TIME_LIMITS, minutes)
  const totalQuestions =
    questions !== null
      ? nearest(QUESTION_COUNTS, questions)
      : minutes !== null
        ? questionsForMinutes(durationMinutes)
        : DEFAULT_TOTAL_QUESTIONS
  return { durationMinutes, totalQuestions }
}
