/**
 * How big a voice sprint is, in one place: the question set builder (drill-pack.ts) uses these to build it, and the lobby
 * says them before the start. A sprint takes the weakest topics, a few questions from each, and never more than the cap.
 */
export const SPRINT_TOPICS = 3
export const SPRINT_QUESTIONS_PER_TOPIC = 4
export const SPRINT_MAX_QUESTIONS = 12
/** A spoken answer and the coach's reply take about this long, so the lobby can say how long the longest sprint is. */
export const SPRINT_MINUTES_PER_QUESTION = 1

/** "Up to 12 questions from your 3 weakest topics, about 12 minutes." */
export function sprintSizeLine(): string {
  return `Up to ${SPRINT_MAX_QUESTIONS} questions from your ${SPRINT_TOPICS} weakest topics, about ${SPRINT_MAX_QUESTIONS * SPRINT_MINUTES_PER_QUESTION} minutes.`
}
