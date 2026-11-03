/**
 * What the browser measures for each turn (spec 19.10). Pure arithmetic over `performance.now()`
 * readings, so it is tested in node. Two reports come out of the same clock:
 * - `timing`, sent with the next turn request (the contract's fields), and
 * - the per-turn metrics entry, posted to /api/voice/metrics (ttft, ttfa, response, speech, tool, interrupts).
 */
import type { VoiceTurnExtras } from '@/lib/voice/turn-contract'
import type { TurnMetrics } from './voice-api'

export type TurnClock = {
  /** The request was sent. */
  start: number
  /** Quiet after the last words of the answer that opened this turn (null when typed or not measured). */
  endpointWaitMs: number | null
  firstEvent: number | null
  firstText: number | null
  firstSentence: number | null
  /** The first audio of the reply, not a filler line. */
  firstSpeak: number | null
  /** The `working` event, and the first thing after it: how long the graded step took as the browser saw it. */
  workingAt: number | null
  afterWorkingAt: number | null
  /** The stream ended with `done`. */
  doneAt: number | null
  /** Milliseconds of reply audio that played. */
  speechMs: number
  interrupted: boolean
}

export const emptyClock = (): TurnClock => ({
  start: 0,
  endpointWaitMs: null,
  firstEvent: null,
  firstText: null,
  firstSentence: null,
  firstSpeak: null,
  workingAt: null,
  afterWorkingAt: null,
  doneAt: null,
  speechMs: 0,
  interrupted: false,
})

/** A whole number of milliseconds from `from` to `to`, or undefined when either is missing or the order is wrong. */
function between(from: number | null, to: number | null): number | undefined {
  if (from === null || to === null) return undefined
  const ms = to - from
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined
}

/** The contract's `timing`: everything measured, nothing invented. */
export function buildTiming(clock: TurnClock): NonNullable<VoiceTurnExtras['timing']> {
  const timing: NonNullable<VoiceTurnExtras['timing']> = {}
  if (clock.endpointWaitMs !== null && Number.isFinite(clock.endpointWaitMs) && clock.endpointWaitMs >= 0) {
    timing.endpointWaitMs = Math.round(clock.endpointWaitMs)
  }
  const firstEvent = between(clock.start, clock.firstEvent)
  const firstSentence = between(clock.start, clock.firstSentence)
  const firstAudio = between(clock.start, clock.firstSpeak)
  if (firstEvent !== undefined) timing.requestToFirstEventMs = firstEvent
  if (firstSentence !== undefined) timing.requestToFirstSentenceMs = firstSentence
  if (firstAudio !== undefined) timing.requestToFirstAudioMs = firstAudio
  timing.interrupted = clock.interrupted
  return timing
}

/** The metrics entry for the turn. Fields with no value are left out. */
export function buildMetrics(clock: TurnClock): TurnMetrics {
  const metrics: TurnMetrics = {}
  const ttft = between(clock.start, clock.firstText)
  const ttfa = between(clock.start, clock.firstSpeak)
  const response = between(clock.start, clock.doneAt)
  const tool = between(clock.workingAt, clock.afterWorkingAt)
  if (ttft !== undefined) metrics.ttftMs = ttft
  if (ttfa !== undefined) metrics.ttfaMs = ttfa
  if (response !== undefined) metrics.responseMs = response
  if (clock.speechMs > 0) metrics.speechMs = Math.round(clock.speechMs)
  if (tool !== undefined) metrics.toolLatencyMs = tool
  if (clock.interrupted) metrics.interrupts = 1
  return metrics
}
