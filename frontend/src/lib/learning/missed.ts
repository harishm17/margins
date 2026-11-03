import { buildReview } from './quiz-review'
import { localDateParts, zonedTimeToUtc } from './study-plan-time'

type RawQuestion = Record<string, unknown>

/** One graded attempt on a topic, with the questions it was taken on (answer keys included). */
export type AttemptForReview = { questions: RawQuestion[]; results: unknown }

export type MissedQuestion = { question: RawQuestion; key: string }

/** How many questions a retry quiz holds at most. */
export const RETRY_LIMIT = 10

/** The same question in two sets is the same question: compare by its text, ignoring case and spacing. */
export function questionKey(question: RawQuestion): string {
  const text = typeof question.question_text === 'string' ? question.question_text : ''
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The questions to retry: those the student got wrong in their last two attempts. `attempts` is
 * newest first and only the first two are read. A question that came up in both attempts counts by
 * its latest result, so one that was missed first and then answered right is no longer missed.
 * Newest misses come first. Nothing is returned when the last two attempts were all right.
 */
export function missedQuestions(attempts: AttemptForReview[], limit = RETRY_LIMIT): MissedQuestion[] {
  const seen = new Set<string>()
  const missed: MissedQuestion[] = []
  for (const attempt of attempts.slice(0, 2)) {
    for (const item of buildReview(attempt.questions, attempt.results)) {
      const question = attempt.questions[item.questionIndex]
      const key = questionKey(question)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (!item.isCorrect) missed.push({ question, key })
    }
  }
  return missed.slice(0, limit)
}

/** The concepts the missed questions test, each once, in the order they appear. */
export function missedConcepts(missed: MissedQuestion[], limit = 6): string[] {
  const concepts = new Map<string, string>()
  for (const { question } of missed) {
    const list = Array.isArray(question.concepts_tested) ? question.concepts_tested : []
    for (const concept of list) {
      if (typeof concept !== 'string') continue
      const text = concept.replace(/\s+/g, ' ').trim()
      if (text && !concepts.has(text.toLowerCase())) concepts.set(text.toLowerCase(), text)
    }
  }
  return [...concepts.values()].slice(0, limit)
}

/** The longest focus text the regenerate route accepts is 280 characters. */
export const FOCUS_LIMIT = 280

/** "Concepts you missed: a; b; c", cut at whole concepts to fit. Null when there is nothing to focus on. */
export function focusFromConcepts(concepts: string[]): string | null {
  const prefix = 'Concepts you missed: '
  let focus = ''
  for (const concept of concepts) {
    const next = focus ? `${focus}; ${concept}` : concept
    if (prefix.length + next.length > FOCUS_LIMIT) break
    focus = next
  }
  return focus ? prefix + focus : null
}

export type ReviewDifficulty = 'easy' | 'medium' | 'hard'

/** Difficulty of a review set from mastery: under 0.4 easy, under 0.75 medium, else hard. No signal is easy. */
export function reviewDifficulty(mastery: number | null | undefined): ReviewDifficulty {
  if (mastery === null || mastery === undefined || Number.isNaN(mastery) || mastery < 0.4) return 'easy'
  return mastery < 0.75 ? 'medium' : 'hard'
}

/** A stable id for a list of questions, to reuse a retry set that holds the same ones. */
export const questionSetKey = (questions: RawQuestion[]): string =>
  questions
    .map(questionKey)
    .sort()
    .join('\n')

/** Questions in a fresh review set: the quiz size and how many come from a prerequisite topic. */
export const FRESH_REVIEW_QUESTIONS = 6
export const FRESH_REVIEW_PREREQUISITE_QUESTIONS = 2

/** The prerequisite to draw review questions from: the weakest one that exists, or null. */
export function pickPrerequisite(
  prerequisites: { id: string; mastery: number | null }[]
): { id: string; mastery: number | null } | null {
  if (prerequisites.length === 0) return null
  return [...prerequisites].sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0))[0]
}

/**
 * When the identical questions can be retried: the start of the next local day after the last
 * attempt. Re-answering the same question straight away mostly tests short-term memory (spec §5.7).
 */
export function retryAvailableAt(lastAttemptAt: Date, timeZone: string): Date {
  const { year, month, day } = localDateParts(lastAttemptAt, timeZone)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return zonedTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, 0, 0, timeZone)
}

/** Why "Retry what you missed" is closed until the next local day (spec §5.7). */
export const RETRY_WAIT_TEXT = 'Available tomorrow. Re-answering the same question right away mostly tests short-term memory.'

/** When the retry opens, or null when it is open now (or there was no attempt). The server and the page use the same rule. */
export function retryOpensAt(lastAttemptAt: Date | null, timeZone: string, now: Date): Date | null {
  if (!lastAttemptAt) return null
  const opens = retryAvailableAt(lastAttemptAt, timeZone)
  return opens.getTime() > now.getTime() ? opens : null
}

/** The concept ids the missed questions test, each once, in the order they appear. */
export function missedConceptIds(missed: MissedQuestion[], limit = 6): string[] {
  const ids = new Set<string>()
  for (const { question } of missed) {
    for (const id of Array.isArray(question.concept_ids) ? question.concept_ids : []) {
      if (typeof id === 'string' && id) ids.add(id)
    }
  }
  return [...ids].slice(0, limit)
}
