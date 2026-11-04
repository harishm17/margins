// What a student sends for each quiz question (spec §5.7): the answer, an optional one-tap
// confidence and optional "show your thinking" text. A quiz started before confidence existed has
// plain string answers in sessionStorage, and those still submit.

import { isConfidenceId, type ConfidenceId } from './calibration'

// `confidenceLevel` is the level the student tapped. It is kept beside the value because two levels can
// store the same value (a guess on a true or false question is 0.5, like "unsure").
// `idk` is the "I don't know" button (spec 18.3): the answer is empty, it is graded wrong, and it carries no confidence.
export type QuizAnswer = { answer: string; confidence?: number; confidenceLevel?: ConfidenceId; thinking?: string; idk?: boolean }
export type RawQuizAnswer = string | QuizAnswer

const MAX_THINKING = 4000

/**
 * Before the draft payload had an `idk` field, an "I don't know" was saved in drafts as this text (invisible, and not
 * something a student types). Drafts live 14 days, so some written before that change can still be stored: reading
 * turns the marker back into the flag. Nothing writes it any more.
 */
export const LEGACY_IDK_MARKER = '\u200bidk\u200b'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Both answer forms as one: strings become `{ answer }`. A confidence outside 0 to 1 is dropped
 * (the answer is kept); empty thinking is dropped. Entries that are neither form are ignored.
 */
export function normalizeAnswers(raw: unknown): Record<string, QuizAnswer> {
  const normalized: Record<string, QuizAnswer> = {}
  if (!isRecord(raw)) return normalized
  for (const [key, value] of Object.entries(raw)) {
    if (value === LEGACY_IDK_MARKER || (isRecord(value) && value.answer === LEGACY_IDK_MARKER)) {
      normalized[key] = { answer: '', idk: true }
    } else if (typeof value === 'string') {
      normalized[key] = { answer: value }
    } else if (isRecord(value) && value.idk === true) {
      // Nothing was answered, so there is no text, no confidence and no thinking to keep.
      normalized[key] = { answer: '', idk: true }
    } else if (isRecord(value) && typeof value.answer === 'string') {
      const entry: QuizAnswer = { answer: value.answer }
      const { confidence, thinking } = value
      if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
        entry.confidence = confidence
      }
      if (entry.confidence !== undefined && isConfidenceId(value.confidenceLevel)) entry.confidenceLevel = value.confidenceLevel
      if (typeof thinking === 'string' && thinking.trim()) entry.thinking = thinking.slice(0, MAX_THINKING)
      normalized[key] = entry
    }
  }
  return normalized
}

/** Whether a question has an answer: some text, or the "I don't know" button. */
export const isAnswered = (answer: QuizAnswer | undefined): boolean => !!answer && (answer.idk === true || !!answer.answer.trim())

export const countAnswered = (answers: Record<string, QuizAnswer>): number => Object.values(answers).filter(isAnswered).length

/** What the quiz view posts: every answered question, an "I don't know" included, and no blanks. */
export function answersToSend(answers: Record<string, QuizAnswer>): Record<string, QuizAnswer> {
  return Object.fromEntries(Object.entries(answers).filter(([, value]) => isAnswered(value)))
}

/** The answers alone, as the graders and the stored attempt read them. */
export function plainAnswers(answers: Record<string, QuizAnswer>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value.answer]))
}

/** The confidence given by question index, for the questions that have one. */
export function confidences(answers: Record<string, QuizAnswer>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(answers)) if (value.confidence !== undefined) out[key] = value.confidence
  return out
}

/** What the grader is sent: the answer, plus the thinking when there is some. Confidence stays out. */
export function answersForGrader(answers: Record<string, QuizAnswer>): Record<string, RawQuizAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      value.thinking ? { answer: value.answer, thinking: value.thinking } : value.answer,
    ])
  )
}

/** What a waiting submission stores: the whole answer, so confidence survives until it is graded. */
export function answersForStorage(answers: Record<string, QuizAnswer>): Record<string, RawQuizAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      value.confidence === undefined && !value.thinking && !value.idk ? value.answer : value,
    ])
  )
}

/** The question indexes the student answered with "I don't know" (so a stored result can tell them from blanks). */
export function dontKnowIndexes(answers: Record<string, QuizAnswer>): Set<number> {
  return new Set(
    Object.entries(answers)
      .filter(([, value]) => value.idk === true)
      .map(([key]) => Number(key))
      .filter(Number.isInteger)
  )
}
