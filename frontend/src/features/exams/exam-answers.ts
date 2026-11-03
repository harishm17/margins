import { confidenceLevelOfAnswer, confidenceOf, plainAnswerOf, type AnswerMap } from '@/lib/exams/attempt-timing'
import type { ConfidenceId } from '@/lib/learning/calibration'

/** What an attempt holds, split the way the form works: text answers, and confidence (value and tapped level) by question. */
export function splitAnswers(stored: AnswerMap): {
  answers: Record<string, string>
  confidence: Record<string, number>
  levels: Record<string, ConfidenceId>
} {
  const answers: Record<string, string> = {}
  const confidence: Record<string, number> = {}
  const levels: Record<string, ConfidenceId> = {}
  for (const [key, value] of Object.entries(stored)) {
    const plain = plainAnswerOf(value)
    if (plain !== null && plain !== undefined) answers[key] = String(plain)
    const sure = confidenceOf(value)
    if (sure !== undefined) confidence[key] = sure
    const level = confidenceLevelOfAnswer(value)
    if (sure !== undefined && level) levels[key] = level
  }
  return { answers, confidence, levels }
}

/**
 * The form's state as the server stores it: a plain value, or `{ answer, confidence }` once the
 * student has said how sure they are. A confidence given before an answer keeps an empty answer.
 */
export function joinAnswers(
  answers: Record<string, string>,
  confidence: Record<string, number>,
  levels: Record<string, ConfidenceId> = {}
): AnswerMap {
  const joined: AnswerMap = {}
  for (const key of new Set([...Object.keys(answers), ...Object.keys(confidence)])) {
    const answer = answers[key] ?? ''
    joined[key] =
      confidence[key] === undefined
        ? answer
        : { answer, confidence: confidence[key], ...(levels[key] ? { confidenceLevel: levels[key] } : {}) }
  }
  return joined
}

/** What the submit prompt says: how many questions are unanswered (they score zero) and how many are flagged. */
export function submitSummary({ total, unanswered, flagged }: { total: number; unanswered: number; flagged: number }): string {
  const count = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`
  const parts = [
    unanswered > 0
      ? `${count(unanswered, 'question')} ${unanswered === 1 ? 'is' : 'are'} unanswered and will score zero.`
      : total === 1
        ? 'You answered the question.'
        : `You answered all ${total} questions.`,
  ]
  if (flagged > 0) parts.push(`${flagged} ${flagged === 1 ? 'is' : 'are'} flagged to come back to.`)
  parts.push('You can’t change your answers after you submit.')
  return parts.join(' ')
}
