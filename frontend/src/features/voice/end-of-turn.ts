/**
 * How long to wait after the student's last words before the turn counts as finished (spec 19.2).
 * Pure logic: the waits and the cap come from the turn contract, shared with the server.
 */
import {
  CONTINUATION_EXTRA_MS,
  END_OF_TURN_CAP_MS,
  END_OF_TURN_WAIT_MS,
  type ListenFor,
} from '@/lib/voice/turn-contract'
import type { VoiceStyle } from './voice-api'

/** A last word like these means the sentence is not finished: the student is still thinking. */
export const CONTINUATION_WORDS: ReadonlySet<string> = new Set([
  'and', 'but', 'so', 'because', 'or', 'then', 'which', 'that', 'if', 'like', 'um', 'uh', 'the', 'a', 'of', 'to', 'with',
])

/** The last word of the text, lower case, without punctuation around it. */
export function lastWordOf(text: string): string {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter(Boolean)
  return words.length > 0 ? words[words.length - 1] : ''
}

export function endsOnContinuationWord(text: string): boolean {
  return CONTINUATION_WORDS.has(lastWordOf(text))
}

/**
 * The wait in milliseconds. `none` (the coach is not waiting for an answer) uses the short wait.
 * A trailing continuation word adds 1.5 s; the total never goes over the 4 s cap.
 */
export function endOfTurnWaitMs(input: { listenFor: ListenFor; text: string }): number {
  const base = END_OF_TURN_WAIT_MS[input.listenFor === 'none' ? 'short_answer' : input.listenFor]
  const extra = endsOnContinuationWord(input.text) ? CONTINUATION_EXTRA_MS : 0
  return Math.min(END_OF_TURN_CAP_MS, base + extra)
}

/**
 * What the session waits for when the server has not said (an older server, or a turn that
 * sent no `listen` event): the usual kind of answer for the style.
 */
export function defaultListenFor(style: VoiceStyle): ListenFor {
  switch (style) {
    case 'teach_back':
      return 'explanation'
    case 'guided_reading':
      return 'prediction'
    default:
      return 'short_answer'
  }
}
