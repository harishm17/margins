/**
 * Timing and answer rules for a timed exam attempt. Pure functions: the server clock is the
 * only clock that counts, and everything here takes `now` as an argument.
 */

import { z } from 'zod'
import { record } from '@/lib/api/fields'
import { isConfidenceId, type ConfidenceId } from '@/lib/learning/calibration'

/** Answers still count this long after the deadline, to cover the round trip of an auto-submit. */
export const DEADLINE_GRACE_MS = 15_000

/** Autosave never keeps more than this many characters for one answer. */
export const MAX_ANSWER_LENGTH = 20_000

/** An exam has at most 100 questions (generate-exam), so an answers body has at most that many entries. */
export const MAX_EXAM_QUESTIONS = 100
/** Room for every answer at its length cap, plus the frame. */
export const EXAM_ANSWERS_MAX_BYTES = MAX_EXAM_QUESTIONS * MAX_ANSWER_LENGTH * 3 + 4096
/** The `{ answers }` body of an autosave or a submit. Values are cleaned by `sanitizeAnswers`; the body size is capped by the reader. */
export const examAnswersSchema = z.object({ answers: record(z.unknown(), MAX_EXAM_QUESTIONS * 2, 4) })

export type PlainAnswer = string | number | boolean | null
/**
 * An answer with how sure the student was (0 to 1); the autosave carries the confidence inside the answer,
 * with the level they tapped (two levels can store the same value on a true or false question).
 */
export type ConfidentAnswer = { answer: PlainAnswer; confidence: number; confidenceLevel?: ConfidenceId }
/** A plain value (an exam started before confidence existed, or one with none given) or the object form. */
export type AnswerValue = PlainAnswer | ConfidentAnswer
export type AnswerMap = Record<string, AnswerValue>

export function deadlineFor(startedAt: Date, durationMinutes: number): Date {
  return new Date(startedAt.getTime() + durationMinutes * 60_000)
}

/** Whole seconds left, rounded up, never below 0. */
export function remainingSeconds(deadlineAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((deadlineAt.getTime() - now.getTime()) / 1000))
}

/** True while answers are still accepted: up to the deadline plus the grace period. */
export function acceptsAnswers(deadlineAt: Date, now: Date, graceMs = DEADLINE_GRACE_MS): boolean {
  return now.getTime() <= deadlineAt.getTime() + graceMs
}

/** True once the time (and grace) is over, so an unfinished attempt should be submitted as saved. */
export function isExpired(deadlineAt: Date, now: Date, graceMs = DEADLINE_GRACE_MS): boolean {
  return !acceptsAnswers(deadlineAt, now, graceMs)
}

/**
 * What a submission is graded on. Within the time limit the answers sent with the submit
 * request win (they are the student's final state). After it, only what was saved before the
 * deadline counts, so answers cannot be edited after time is up.
 */
export function resolveFinalAnswers(input: {
  saved: AnswerMap
  submitted: AnswerMap | null | undefined
  deadlineAt: Date
  now: Date
}): { answers: AnswerMap; usedSubmitted: boolean } {
  if (input.submitted && acceptsAnswers(input.deadlineAt, input.now)) {
    return { answers: input.submitted, usedSubmitted: true }
  }
  return { answers: input.saved, usedSubmitted: false }
}

const isPlainAnswer = (value: unknown): value is PlainAnswer =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function cleanPlain(value: unknown): PlainAnswer | undefined {
  if (!isPlainAnswer(value)) return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  return typeof value === 'string' ? value.slice(0, MAX_ANSWER_LENGTH) : value
}

/** A usable answer: a plain value, or `{ answer, confidence, confidenceLevel? }`. A confidence outside 0 to 1 is dropped, the answer kept. */
function cleanAnswer(value: unknown): AnswerValue | undefined {
  if (!isRecord(value)) return cleanPlain(value)
  const answer = cleanPlain(value.answer)
  if (answer === undefined) return undefined
  const { confidence } = value
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return answer
  return isConfidenceId(value.confidenceLevel) ? { answer, confidence, confidenceLevel: value.confidenceLevel } : { answer, confidence }
}

/** The answer alone, whichever form it is stored in. */
export function plainAnswerOf(value: unknown): PlainAnswer | undefined {
  return isRecord(value) ? cleanPlain(value.answer) : cleanPlain(value)
}

/** The level the student tapped, when it was stored with the confidence. */
export function confidenceLevelOfAnswer(value: unknown): ConfidenceId | undefined {
  return isRecord(value) && isConfidenceId(value.confidenceLevel) ? value.confidenceLevel : undefined
}

/** How sure the student said they were, when they said. */
export function confidenceOf(value: unknown): number | undefined {
  return isRecord(value) && typeof value.confidence === 'number' ? value.confidence : undefined
}

/**
 * Keep only answers for real question indexes with a plain value, and cap their length.
 * Returns null when the input is not an object of answers at all.
 */
export function sanitizeAnswers(input: unknown, questionCount: number): AnswerMap | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const clean: AnswerMap = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^\d{1,4}$/.test(key)) continue
    if (Number(key) >= questionCount) continue
    const answer = cleanAnswer(value)
    if (answer !== undefined) clean[key] = answer
  }
  return clean
}

/** The answers stored on an attempt, as an AnswerMap (anything unusable is dropped). */
export function readStoredAnswers(value: unknown): AnswerMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const clean: AnswerMap = {}
  for (const [key, answer] of Object.entries(value as Record<string, unknown>)) {
    const kept = cleanAnswer(answer)
    if (kept !== undefined) clean[key] = kept
  }
  return clean
}
