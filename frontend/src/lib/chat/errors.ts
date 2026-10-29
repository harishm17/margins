import { aiMessage, isKnownAiCode } from '@/lib/ai/messages'
import { fillResetTime } from '@/lib/budget/copy'

/**
 * Friendly text for the error codes the chat can fail with. AI availability, the allowance and
 * busy errors read as everywhere else (lib/ai/messages); this table has only what is particular
 * to asking a question.
 */

export type ChatErrorInfo = { message: string; retryable: boolean; status: number }

const CHAT_ONLY: Record<string, ChatErrorInfo> = {
  RATE_LIMITED: { message: 'You are asking too fast. Wait a moment and try again.', retryable: true, status: 429 },
  LLM_REQUEST_REJECTED: { message: 'The AI could not take that question. Try asking it differently.', retryable: false, status: 502 },
  LLM_REFUSED: {
    message: 'The model declined to answer that. Try rephrasing the question.',
    retryable: false,
    status: 502,
  },
  LLM_BAD_OUTPUT: {
    message: 'The answer came back empty or cut off. Try a narrower question.',
    retryable: true,
    status: 502,
  },
  RETRIEVAL_FAILED: { message: 'Could not search your materials just now. Try again.', retryable: true, status: 503 },
  PROJECT_NOT_FOUND: { message: 'That project was not found.', retryable: false, status: 404 },
  CHAT_UNAVAILABLE: { message: 'The AI is not reachable right now. Try again in a moment.', retryable: true, status: 503 },
  CHAT_INTERRUPTED: { message: 'The answer was interrupted before it finished. Try again.', retryable: true, status: 502 },
  CHAT_NOT_SAVED: { message: 'The answer could not be saved to this conversation. It is shown here only.', retryable: false, status: 500 },
  CHAT_FAILED: { message: 'The answer could not be written. Try again.', retryable: true, status: 502 },
}

const FALLBACK: ChatErrorInfo = { message: 'Something went wrong while answering. Try again.', retryable: true, status: 502 }

function lookup(code: string): ChatErrorInfo {
  if (CHAT_ONLY[code]) return CHAT_ONLY[code]
  if (isKnownAiCode(code)) {
    const shared = aiMessage(code)
    return { message: shared.text, retryable: shared.retry, status: code === 'LLM_DAILY_BUDGET' ? 429 : 503 }
  }
  return FALLBACK
}

/**
 * The message to show for `code`. An unknown code gets a generic message: the text the AI
 * service sends can carry internal detail (the budget message carries dollar figures), so it is
 * logged by the server and never shown.
 */
export function chatErrorMessage(code: string): ChatErrorInfo {
  const info = lookup(code)
  // The budget message has the reset time as a token. In the browser it becomes the student's
  // local time; a server leaves it, and the browser fills it in when the message arrives.
  return typeof window === 'undefined' ? info : { ...info, message: fillResetTime(info.message) }
}
