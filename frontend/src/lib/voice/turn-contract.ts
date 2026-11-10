/**
 * The v3.2 voice turn contract between the browser and the turn route (spec section 19).
 * Both sides import these types; neither invents its own field names.
 */

/** What the session is waiting for next, so the client can set its end-of-turn wait (spec 19.2). */
export type ListenFor = 'short_answer' | 'prediction' | 'explanation' | 'none'

/** End-of-turn waits in milliseconds after the last recognised words (spec 19.2). */
export const END_OF_TURN_WAIT_MS: Record<Exclude<ListenFor, 'none'>, number> = {
  short_answer: 1200,
  prediction: 1500,
  explanation: 2200,
}
/** Added when the last word is a continuation word; the total never exceeds the cap. */
export const CONTINUATION_EXTRA_MS = 1500
export const END_OF_TURN_CAP_MS = 4000

/** Sent by the client with a student turn. */
export interface VoiceTurnExtras {
  /** When the student interrupted the coach's last reply: the text they heard before it stopped (spec 19.4). */
  interruptedHeard?: string
  /** Client-side timings for the previous turn (spec 19.10). All in milliseconds; omit what was not measured. */
  timing?: {
    endpointWaitMs?: number
    requestToFirstEventMs?: number
    requestToFirstSentenceMs?: number
    requestToFirstAudioMs?: number
    interrupted?: boolean
    /** What turned the student's speech into text for this turn (spec 19.12): cloud, on-device, or the browser's service. */
    recognizer?: 'cloud' | 'device' | 'browser'
  }
}

/** Stream events the route adds in v3.2 (alongside the existing ones). */
export type VoiceStreamExtra =
  /** Sent as soon as the server starts a graded step for this utterance (spec 19.3). */
  | { type: 'working'; step: 'assess' | 'record_answer' | 'reveal' | 'record_check' }
  /** Sent with the end of each coach turn: what the session waits for next (spec 19.2). */
  | { type: 'listen'; for: ListenFor }
  /** The call just streamed was cut off at its token limit and is being asked again: drop what has not been spoken of it. */
  | { type: 'retract' }

/** Sent once when a session starts: the topic's key terms (spec 19.5), at most 100. */
export interface VoiceSessionTerms {
  courseTerms: string[]
}
