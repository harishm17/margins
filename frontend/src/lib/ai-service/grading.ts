import { aiServiceHeaders } from '@/lib/ai-service/headers'

export type GradedQuestion = {
  question_index: number
  question_type: string
  points_possible: number
  points_earned: number
  is_correct: boolean
  feedback: string
  needs_review: boolean
  /** Short answers: the verdict on each key point, in rubric order. */
  criteria?: { point: string; result: 'met' | 'partly' | 'not_met' }[]
}

export type GradeResult = {
  graded_questions: GradedQuestion[]
  total_points: number
  earned_points: number
  overall_score: number
  needs_review: boolean
}

/**
 * The AI service could not grade (down, over capacity, or a short answer failed). Nothing is
 * stored: a grading the model could not do must never become a 0. `code` is the AI service's
 * error code when it gave one (LLM_CREDIT_EXHAUSTED, ...).
 */
export class GradingUnavailableError extends Error {
  readonly code: string | null
  constructor(message = 'Grading is unavailable right now', code: string | null = null) {
    super(message)
    this.name = 'GradingUnavailableError'
    this.code = code
  }
}

/** Shown when short answers cannot be graded because the AI cannot run (copy for review). */
export const GRADING_WAITS_FOR_AI =
  'Your answers are still here. Short answers need AI to grade, so submit again when AI is available.'
/** Shown when the model answered but could not grade some short answers. */
export const GRADING_RETRY = 'Some short answers could not be graded just now. Your answers are still here, so submit again.'

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error_code?: unknown }
    return typeof body.error_code === 'string' ? body.error_code : null
  } catch {
    return null
  }
}

const GRADING_TIMEOUT_MS = 90_000

/**
 * Grade answers against questions the server loaded from its own database.
 * `answers` maps question index (as a string) to the student's answer.
 */
export async function gradeAnswers(
  questions: unknown[],
  answers: Record<string, string>
): Promise<GradeResult> {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000'

  let response: Response
  try {
    response = await fetch(`${aiServiceUrl}/grade/quiz`, {
      method: 'POST',
      headers: aiServiceHeaders(),
      body: JSON.stringify({ questions, answers }),
      signal: AbortSignal.timeout(GRADING_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('Grading request failed:', error)
    throw new GradingUnavailableError(GRADING_WAITS_FOR_AI, 'AI_UNREACHABLE')
  }

  if (!response.ok) {
    const code = await errorCode(response)
    console.error('Grading request returned', response.status, code)
    throw new GradingUnavailableError(GRADING_WAITS_FOR_AI, code)
  }

  const result = (await response.json()) as GradeResult
  if (result.needs_review) throw new GradingUnavailableError(GRADING_RETRY)
  return result
}
