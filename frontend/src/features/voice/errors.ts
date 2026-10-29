/**
 * Friendly copy for every way a voice turn can fail (the errors before
 * the stream starts and the `error` event). The server's own `message` is safe to show, but it
 * is written for any client; these lines say what the student can do about it.
 */

import { aiMessage } from '@/lib/ai/messages'
import { fillResetTime } from '@/lib/budget/copy'

export type TurnFailure = {
  /** `error.details.code` when there is one, else `error.code`, or the stream's `code`. */
  code: string
  message: string
  retryable: boolean
  status?: number
}

export type VoiceAlertAction = 'retry' | 'sign-in' | 'none'

export type VoiceAlert = {
  tone: 'neutral' | 'warning' | 'danger'
  title: string
  text: string
  action: VoiceAlertAction
}

/**
 * What the session does next:
 * - continue: stay in the session and show the alert (with a retry button when it makes sense)
 * - summary: the session cannot go on; show the summary
 * - lobby: only on the very first turn; go back to the lobby, the session never started
 */
export type TurnFate = 'continue' | 'summary' | 'lobby'

export type TurnFailureView = { alert: VoiceAlert; fate: TurnFate; limitReached?: boolean }

export function describeTurnFailure(failure: TurnFailure): TurnFailureView {
  switch (failure.code) {
    case 'SESSION_ENDED':
      return {
        fate: 'summary',
        alert: { tone: 'neutral', title: 'This session has ended', text: 'Start a new one whenever you are ready.', action: 'none' },
      }
    case 'ACTIVE_SESSION':
      return {
        fate: 'lobby',
        alert: {
          tone: 'warning',
          title: 'Another voice practice is open',
          text: 'End it in the other tab or window, then start again. It also clears by itself after about a minute.',
          action: 'none',
        },
      }
    case 'VOICE_DAILY_LIMIT':
      return {
        fate: 'lobby',
        limitReached: true,
        alert: {
          tone: 'warning',
          title: "You've used today's voice time",
          text: 'It resets within 24 hours.',
          action: 'none',
        },
      }
    case 'TURN_IN_PROGRESS':
      return {
        fate: 'continue',
        alert: {
          tone: 'neutral',
          title: 'The coach is still finishing the last answer',
          text: 'Give it a moment, then try again.',
          action: 'retry',
        },
      }
    case 'RATE_LIMITED':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: "You're going a little fast",
          text: 'Wait a few seconds, then try again.',
          action: 'retry',
        },
      }
    case 'LLM_DAILY_BUDGET': {
      const message = aiMessage(failure.code)
      return {
        fate: 'summary',
        alert: { tone: 'warning', title: message.title, text: fillResetTime(message.text), action: 'none' },
      }
    }
    case 'VOICE_UNAVAILABLE':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: "The coach isn't reachable",
          text: "We couldn't reach the voice service. Try again in a moment.",
          action: 'retry',
        },
      }
    case 'LLM_NOT_CONFIGURED':
    case 'LLM_AUTH_FAILED':
    case 'LLM_CREDIT_EXHAUSTED': {
      // The same words as every other surface (lib/ai/messages).
      const message = aiMessage(failure.code)
      return {
        fate: 'summary',
        alert: { tone: message.tone, title: message.title, text: message.text, action: 'none' },
      }
    }
    case 'LLM_RATE_LIMITED':
    case 'LLM_UNAVAILABLE': {
      const message = aiMessage(failure.code)
      return {
        fate: 'continue',
        alert: { tone: message.tone, title: message.title, text: message.text, action: 'retry' },
      }
    }
    case 'LLM_REFUSED':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: "The coach couldn't answer that",
          text: 'Try saying it a different way, or skip to the next question.',
          action: 'none',
        },
      }
    case 'LLM_REQUEST_REJECTED':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: "The coach couldn't use that reply",
          text: 'Try a shorter answer, or skip to the next question.',
          action: 'none',
        },
      }
    case 'LLM_BAD_OUTPUT':
    case 'VOICE_TURN_FAILED':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: 'The coach slipped',
          text: 'Something went wrong with that reply.',
          action: failure.retryable ? 'retry' : 'none',
        },
      }
    case 'VOICE_INTERRUPTED':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: 'The connection dropped',
          text: 'The reply was cut off. Try again.',
          action: 'retry',
        },
      }
    case 'VOICE_NOT_SAVED':
      return {
        fate: 'continue',
        alert: {
          tone: 'neutral',
          title: "That reply wasn't saved",
          text: 'The coach may repeat itself. You can carry on.',
          action: 'none',
        },
      }
    case 'UNAUTHORIZED':
      return {
        fate: 'continue',
        alert: {
          tone: 'danger',
          title: "You're signed out",
          text: 'Sign in again to continue.',
          action: 'sign-in',
        },
      }
    case 'NETWORK':
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: "You're offline",
          text: 'Check your connection, then try again.',
          action: 'retry',
        },
      }
    case 'NOT_FOUND':
      return {
        fate: 'summary',
        alert: {
          tone: 'neutral',
          title: "We couldn't find this session",
          text: 'Start a new one to carry on.',
          action: 'none',
        },
      }
    default:
      return {
        fate: 'continue',
        alert: {
          tone: 'warning',
          title: 'Something went wrong',
          text: failure.message || 'Try again in a moment.',
          action: failure.retryable ? 'retry' : 'none',
        },
      }
  }
}

/** What a failed session start (before any turn) shows in the lobby. */
export type LobbyAlert =
  | { kind: 'needs-generation' }
  | { kind: 'turn'; alert: VoiceAlert }
  | { kind: 'error'; text: string }
