// What is being written on one question of an item session: the payload of the `review` draft surface (spec §18.7).
// The review page and the warm-up both keep their current answer and confidence in it. No database or React imports.

import { normalizeAnswers } from '@/lib/learning/quiz-answers'

export type ReviewDraft = { answer: string; thinking?: string; confidence?: number; confidenceLevel?: string }

export function parseReviewDraft(raw: unknown): ReviewDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.answer !== 'string') return null
  const answer = normalizeAnswers({ '0': value })['0']
  return {
    answer: value.answer,
    ...(answer?.thinking ? { thinking: answer.thinking } : {}),
    ...(answer?.confidence !== undefined ? { confidence: answer.confidence } : {}),
    ...(answer?.confidenceLevel ? { confidenceLevel: answer.confidenceLevel } : {}),
  }
}
