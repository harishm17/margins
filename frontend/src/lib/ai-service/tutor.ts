import { aiServiceHeaders } from '@/lib/ai-service/headers'
import type { MissKind } from '@/lib/tutor/state'

/** The body of POST /tutor/practice (ai-service PracticeTutorRequest). */
export type PracticeTutorRequest = {
  problem: string
  steps: { question: string; answer: string; acceptable_answers: string[]; tolerance?: number; hints: string[] }[]
  step_index: number
  working: string
  attempts: string[]
  hints_shown: string[]
  rung_allowed: number
  move: string
  final_allowed: boolean
  /** The answer the server graded as right, which a reply may confirm; the browser's own text is never used for it. */
  own_answer?: string
  ask_what_is_unclear: boolean
  claims: { text: string; quote: string; page?: number }[]
  weak_prerequisite?: { name: string; page?: number }
  first_wrong_step?: number
  confusable?: { name: string; summary: string }
  user_id: string
  project_id: string
  session_id?: string
}

/** The reply the service sends back (it never carries the model's private notes). */
export type PracticeTutorAnswer = {
  reply: string
  rung_used: number
  mistake: { located: boolean; where: string; kind: MissKind | null }
  reveals_answer: boolean
  leaked: boolean
  from_authored_hint: boolean
}

/** The tutor could not answer now. `code` is the AI service's error code when it gave one; `status` the HTTP status it answered with. */
export class TutorUnavailableError extends Error {
  readonly code: string | null
  readonly status: number
  constructor(code: string | null, status: number) {
    super(`The tutor is unavailable (${status}${code ? `, ${code}` : ''})`)
    this.name = 'TutorUnavailableError'
    this.code = code
    this.status = status
  }
}

// A reply can take a second model call to clear the leak check, and a third to regenerate. Recall grading is one call.
const TUTOR_TIMEOUT_MS = 60_000

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error_code?: unknown }
    return typeof body.error_code === 'string' ? body.error_code : null
  } catch {
    return null
  }
}

export async function postTutor<T>(path: string, request: unknown): Promise<T> {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000'
  let response: Response
  try {
    response = await fetch(`${aiServiceUrl}${path}`, {
      method: 'POST',
      headers: aiServiceHeaders(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TUTOR_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('Tutor request failed:', error)
    throw new TutorUnavailableError('AI_UNREACHABLE', 503)
  }
  if (!response.ok) {
    const code = await errorCode(response)
    console.error('Tutor request returned', response.status, code)
    throw new TutorUnavailableError(code, response.status)
  }
  return (await response.json()) as T
}

export const requestPracticeTutor = (request: PracticeTutorRequest): Promise<PracticeTutorAnswer> => postTutor('/tutor/practice', request)

/** The body of POST /tutor/reader (ai-service ReaderTutorRequest). */
export type ReaderTutorRequest = {
  passage: string
  chunk_id: string
  student_take: string
  cant_parse: boolean
  rung: number
  claims: { text: string; quote: string; page?: number }[]
  user_id: string
  project_id: string
  session_id?: string
}

/** The statements about the passage and the one check question that ends them. */
export type ReaderTutorAnswer = { reply: string; check_question: string }

export const requestReaderTutor = (request: ReaderTutorRequest): Promise<ReaderTutorAnswer> => postTutor('/tutor/reader', request)
