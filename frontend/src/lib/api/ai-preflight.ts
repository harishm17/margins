import { NextResponse } from 'next/server'
import { ApiErrorCode, apiError } from '@/lib/api/errors'
import { aiMessage, refusalStatus } from '@/lib/ai/messages'
import { blockedCode } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'

/**
 * Call before creating any job that runs the model. Refuses, before anything is stored, when AI is
 * unavailable (the shared status) or the user has used today's allowance, with a typed code in
 * `error.details.code` and the shared student-facing text (lib/ai/messages); never the AI
 * service's own words. Null when the job may start.
 *
 * Not for grading a student's work (exam submit, Grade again): that is always accepted and the
 * grading job waits for the AI instead.
 */
export async function ensureAiGenerationReady(userId: string): Promise<NextResponse | null> {
  const code = blockedCode(await getAiStatus(userId))
  if (!code) return null
  return aiRefusal(code)
}

/** The refusal response for `code` (also used when the AI service refuses a call itself). */
export function aiRefusal(code: string): NextResponse {
  const message = aiMessage(code)
  return apiError(
    code === 'LLM_DAILY_BUDGET' ? ApiErrorCode.RATE_LIMITED : ApiErrorCode.UPSTREAM_ERROR,
    message.text,
    { code, retryable: message.retry },
    refusalStatus(code)
  )
}
