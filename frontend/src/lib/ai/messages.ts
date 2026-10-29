/**
 * What a student is told about anything the AI did not do: a job that failed, a chat answer or a
 * voice turn that failed, or a request refused before it started (AI unavailable, allowance used).
 * One table for every surface, by error code, so the same failure reads the same everywhere.
 *
 * Error messages from the AI service are written for logs and can carry provider wording or dollar
 * figures, so none of them is shown: every code gets text chosen here. Provider problems (out of
 * credit, a rejected key, no key) all read the same, as AI being unavailable for now.
 *
 * The allowance text has the reset time as RESET_TOKEN; the browser fills in the student's local
 * time (see lib/budget/copy).
 */

import { ALLOWANCE_TEMPLATE } from '@/lib/budget/copy'

export type AiTone = 'neutral' | 'warning' | 'danger'

export type AiMessage = {
  /** A short heading, for alerts and banners. */
  title: string
  /** A sentence or two that reads on its own (some surfaces show only this). */
  text: string
  tone: AiTone
  /** Whether trying the same thing again soon may work. */
  retry: boolean
}

const UNAVAILABLE: AiMessage = {
  title: 'AI features are unavailable',
  text: "AI features are paused right now. Your files and progress are safe. Try again later.",
  tone: 'warning',
  retry: false,
}

const BUSY: AiMessage = {
  title: 'AI is busy',
  text: 'The AI is busy right now. Try again in a few minutes.',
  tone: 'warning',
  retry: true,
}

const ALLOWANCE: AiMessage = {
  title: "You've used today's AI allowance",
  text: ALLOWANCE_TEMPLATE,
  tone: 'warning',
  retry: false,
}

const failed = (text: string, retry = true): AiMessage => ({ title: 'Something went wrong', text, tone: 'danger', retry })

/** Codes that mean AI cannot be used by anyone until it is fixed on our side. */
export const UNAVAILABLE_CODES = ['LLM_CREDIT_EXHAUSTED', 'LLM_AUTH_FAILED', 'LLM_NOT_CONFIGURED', 'AI_UNREACHABLE'] as const

const MESSAGES: Record<string, AiMessage> = {
  // Availability and allowance: the same for every surface.
  LLM_CREDIT_EXHAUSTED: UNAVAILABLE,
  LLM_AUTH_FAILED: UNAVAILABLE,
  LLM_NOT_CONFIGURED: UNAVAILABLE,
  // The web app could not reach the AI service at all.
  AI_UNREACHABLE: { ...UNAVAILABLE, retry: true },
  LLM_RATE_LIMITED: BUSY,
  LLM_UNAVAILABLE: BUSY,
  LLM_DAILY_BUDGET: ALLOWANCE,

  // The model answered, but not usefully.
  LLM_BAD_OUTPUT: failed('The AI returned an answer the app could not use. Retrying usually works.'),
  LLM_REFUSED: failed('The AI declined to write this from your material. Retrying may help.'),
  LLM_REQUEST_REJECTED: failed('The AI could not take this request. Retrying may help.'),

  // Jobs.
  NO_SOURCE_MATERIAL: failed(
    'None of your uploaded material matched this topic, so there was nothing to write from. Add material that covers it or edit the topic, then retry.',
    false
  ),
  NO_CONTENT_MATERIALS: failed(
    'Every material in this course is marked as a syllabus or a past exam, so there was nothing to find topics in. Mark at least one as course content, then find topics again.',
    false
  ),
  ENQUEUE_FAILED: failed('The job could not be started. Retry in a moment.'),
  ENQUEUE_PERMANENT: failed('The job could not be started. Retry in a moment.'),
  JOB_DISPATCH_FAILED: failed('The job could not be started. Retry in a moment.'),
  JOB_LEASE_EXPIRED: failed('The work stopped before it finished. Try again.'),
  STORAGE_UNAVAILABLE: failed('Your files could not be read just now. Retry in a moment.'),
  // The default code each kind of job fails with when nothing more specific is known.
  VALIDATION_FAILED: failed('We could not check this file. Remove it and upload it again.'),
  CHUNKING_FAILED: failed('We could not read the pages of this file. Remove it and upload it again, or try another copy.'),
  TOPIC_EXTRACTION_FAILED: failed('We could not find the topics in your files. Try again.'),
  CONTENT_GENERATION_FAILED: failed('The study content could not be written. Try again.'),
  EXAM_GENERATION_FAILED: failed('The mock exam could not be written. Try again.'),
  EXAM_GRADING_FAILED: failed('We could not finish grading it. Grade the exam again to see your score.'),
  EXAM_PROFILE_FAILED: failed('We could not read the style of your past exams. Try again, or mock exams will use the default style.'),
  EXAM_RELEVANCE_FAILED: failed('We could not match your past exams to your topics. Try again.'),
  MATERIAL_NOT_FOUND: failed('That file was removed before it could be read.', false),
  SUBMISSION_NOT_FOUND: failed('That exam attempt could not be found, so it could not be graded.', false),
  INVALID_INPUT: failed('The request was not complete. Try again.'),
}

/**
 * What a failure says when its code is not one of the above, by the kind of job that failed. A
 * grading job never says "Generation failed": the student reads what went wrong with the thing
 * they asked for.
 */
const FALLBACK_BY_JOB_TYPE: Record<string, string> = {
  validate_material: 'VALIDATION_FAILED',
  chunk_material: 'CHUNKING_FAILED',
  extract_topics: 'TOPIC_EXTRACTION_FAILED',
  generate_content: 'CONTENT_GENERATION_FAILED',
  generate_exam: 'EXAM_GENERATION_FAILED',
  grade_exam: 'EXAM_GRADING_FAILED',
  profile_exam: 'EXAM_PROFILE_FAILED',
  exam_relevance: 'EXAM_RELEVANCE_FAILED',
}

export const FALLBACK_MESSAGE: AiMessage = failed('Something went wrong. Try again.')

/** Whether this code is one the shared table knows. */
export const isKnownAiCode = (code: string | null | undefined): boolean => !!code && code in MESSAGES

/** Whether the code means AI is unavailable for everyone (the banner's reasons). */
export const isUnavailableCode = (code: string | null | undefined): boolean =>
  !!code && (UNAVAILABLE_CODES as readonly string[]).includes(code)

/**
 * The message for `code`. Unknown codes fall back by job type (when given), then to a generic
 * message; nothing the server wrote is ever passed through.
 */
export function aiMessage(code: string | null | undefined, jobType?: string | null): AiMessage {
  if (code && MESSAGES[code]) return MESSAGES[code]
  const byJob = jobType ? FALLBACK_BY_JOB_TYPE[jobType] : undefined
  return byJob ? MESSAGES[byJob] : FALLBACK_MESSAGE
}

/** The HTTP status a refusal with this code is answered with. */
export function refusalStatus(code: string): number {
  if (code === 'LLM_DAILY_BUDGET') return 429
  return 503
}
