/**
 * How big a quick round is, in one place: the question set builder (drill-pack.ts) uses these to build it, and the lobby
 * says the size the round really has before the start. A round takes the weakest topics, a few questions from each,
 * and never more than the cap.
 */
export const SPRINT_TOPICS = 3
export const SPRINT_QUESTIONS_PER_TOPIC = 4
export const SPRINT_MAX_QUESTIONS = 12
/** A spoken answer and the coach's reply take about this long, so the lobby can say how long the round is. */
export const SPRINT_MINUTES_PER_QUESTION = 1

/** What a round has before it starts (drill-pack.ts, sprintPreview): questions ready to ask, and topics whose questions are written at Start. */
export type SprintPreview = { ready: number; writes: string[] }

const count = (n: number) => (n === 1 ? '1 question' : `${n} questions`)
const minutes = (n: number) => (n === 1 ? 'about a minute' : `about ${n * SPRINT_MINUTES_PER_QUESTION} minutes`)

/**
 * "8 questions, about 8 minutes." The count is the round's own. Topics with notes and no question the coach can ask
 * aloud get theirs written at Start, so the line says "at least" and names them.
 */
export function sprintSizeLine(preview: SprintPreview): string {
  const written = preview.writes.length > 0 ? `the coach writes ${preview.ready > 0 ? 'more' : 'the questions'} from your notes on ${nameList(preview.writes)} when you start` : ''
  if (preview.ready === 0) return written ? `${written[0].toUpperCase()}${written.slice(1)}.` : 'No questions to ask yet.'
  return written ? `At least ${count(preview.ready)}; ${written}.` : `${count(preview.ready)}, ${minutes(preview.ready)}.`
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
