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
 * scored: a grading the model could not do must never become a 0. A topic quiz is stored and graded
 * when the AI is back (lib/learning/quiz-submissions); a voice drill says so. `code` is the AI service's
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

/**
 * The AI service refused the request itself (a question it cannot read, a bad token, a bug): not a
 * matter of waiting for the AI, so nothing is queued and the caller reports an error. `status` is
 * the HTTP status it answered with.
 */
export class GradingRejectedError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`The grading request was rejected (${status})`)
    this.name = 'GradingRejectedError'
    this.status = status
  }
}

/** The AI service's codes for "the AI cannot run now": the ones exam grading waits on (ai-service job_runner waits_for_ai). */
const WAIT_CODES = new Set([
  'LLM_CREDIT_EXHAUSTED',
  'LLM_AUTH_FAILED',
  'LLM_NOT_CONFIGURED',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_DAILY_BUDGET',
  'AI_UNREACHABLE',
])

/** Whether a failed grading call means the AI is unavailable (worth waiting for) rather than that the request was refused. */
export function isAiUnavailableOutcome(status: number, code: string | null): boolean {
  if (code && WAIT_CODES.has(code)) return true
  // No code: a gateway or the service itself is down or restarting.
  return !code && (status === 429 || status === 502 || status === 503 || status === 504)
}

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
    throw new GradingUnavailableError(undefined, 'AI_UNREACHABLE')
  }

  if (!response.ok) {
    const code = await errorCode(response)
    console.error('Grading request returned', response.status, code)
    if (!isAiUnavailableOutcome(response.status, code)) throw new GradingRejectedError(response.status)
    throw new GradingUnavailableError(undefined, code)
  }

  const result = (await response.json()) as GradeResult
  if (result.needs_review) throw new GradingUnavailableError('Some short answers could not be graded just now')
  return result
}
