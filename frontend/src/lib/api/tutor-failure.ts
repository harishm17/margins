import { TutorUnavailableError } from '@/lib/ai-service/tutor'
import { aiMessage } from '@/lib/ai/messages'
import { ApiErrorCode, apiError } from '@/lib/api/errors'

/**
 * The response for a call to the AI service's tutor or grader routes that could not be answered. The
 * student reads why in the shared words (lib/ai/messages) and what they were doing is left as it was.
 */
export function tutorFailure(error: TutorUnavailableError) {
  // The service refused the request itself (not a matter of waiting for the AI): a plain error, not "AI is busy".
  if (error.status >= 400 && error.status < 500 && error.status !== 429 && !error.code) {
    return apiError(ApiErrorCode.UPSTREAM_ERROR, 'The tutor could not take that request.', { code: 'TUTOR_REJECTED', retryable: false }, 422)
  }
  const code = error.code ?? (error.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_UNAVAILABLE')
  const message = aiMessage(code)
  return apiError(
    code === 'LLM_DAILY_BUDGET' ? ApiErrorCode.RATE_LIMITED : ApiErrorCode.UPSTREAM_ERROR,
    message.text,
    { code, retryable: message.retry },
    code === 'LLM_DAILY_BUDGET' || error.status === 429 ? 429 : 503
  )
}
