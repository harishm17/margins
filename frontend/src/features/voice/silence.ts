/**
 * Turns the speech recognizer's running result list into whole utterances.
 *
 * Pure logic (timers are injected) so it can be tested without a browser. The recognizer
 * (continuous, interim results) reports every result so far; a result is "final" once the
 * recognizer is sure of it. We treat the utterance as finished when everything pending is
 * final and the end-of-turn wait passes with no new result (end-of-turn.ts: it depends on what
 * the student is doing and on how the last words end). If a result stays interim for a long time
 * (some browsers never finalise the last phrase) `staleInterimMs` commits it anyway.
 */
import { END_OF_TURN_CAP_MS, END_OF_TURN_WAIT_MS } from '@/lib/voice/turn-contract'

export type SpeechResult = { transcript: string; isFinal: boolean }

export type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const STALE_INTERIM_MS = 2500
/** The quiet that makes the screen say "still listening" (the wait itself is longer). */
export const HOLD_AFTER_MS = 700
/** Shorter than this (after trimming) is noise ("uh", a click) and is dropped. */
export const MIN_UTTERANCE_CHARS = 2

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function joinTranscripts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Something a person could have said: at least one letter or digit, and long enough. */
export function isSpeakable(text: string, minChars = MIN_UTTERANCE_CHARS): boolean {
  const trimmed = text.trim()
  return trimmed.length >= minChars && /[\p{L}\p{N}]/u.test(trimmed)
}

/** What the collector knows when it picks the wait: the words so far and whether the last one is still interim. */
export type WaitInfo = { text: string; interim: boolean }

/** How a finished utterance ended: `waitedMs` of quiet after the last words, or the student pressed Done. */
export type CommitInfo = { waitedMs: number; early: boolean }

export type UtteranceCollectorOptions = {
  /** The wait after the last words for these words; default is the short-answer wait. */
  waitMs?: (info: WaitInfo) => number
  staleInterimMs?: number
  holdAfterMs?: number
  minChars?: number
  timers?: Timers
  now?: () => number
  /** A finished utterance, the joined final segments. */
  onCommit: (text: string, info: CommitInfo) => void
  /** The words heard so far and not yet committed (final and interim together). */
  onInterim?: (text: string) => void
  /** True once the quiet has lasted `holdAfterMs` with words pending (the wait is running); false when it ends. */
  onHold?: (holding: boolean) => void
}

export type UtteranceCollector = {
  /** Feed the full result list of the current recognition run. */
  update: (results: SpeechResult[]) => void
  /** The text of `results` that has not been committed or skipped yet. */
  peek: (results: SpeechResult[]) => string
  /** Forget everything heard so far (echo of the coach, or the mic was paused). */
  skip: (results: SpeechResult[]) => void
  /** Commit what is pending now, without waiting for silence (the Done control, or the recognizer ended). */
  flush: () => void
  /** The recognizer restarted: its result list starts again from zero. */
  reset: () => void
  dispose: () => void
}

export function createUtteranceCollector(options: UtteranceCollectorOptions): UtteranceCollector {
  const waitMs = options.waitMs ?? (() => END_OF_TURN_WAIT_MS.short_answer)
  const holdAfterMs = options.holdAfterMs ?? HOLD_AFTER_MS
  const now = options.now ?? Date.now
  const staleInterimMs = options.staleInterimMs ?? STALE_INTERIM_MS
  const minChars = options.minChars ?? MIN_UTTERANCE_CHARS
  const timers = options.timers ?? browserTimers

  let consumed = 0
  let lastLength = 0
  let pending: SpeechResult[] = []
  let timer: unknown = null
  let holdTimer: unknown = null
  let holding = false
  let lastResultAt = 0

  const setHolding = (next: boolean) => {
    if (holding === next) return
    holding = next
    options.onHold?.(next)
  }

  const clearTimer = () => {
    if (timer !== null) timers.clear(timer)
    if (holdTimer !== null) timers.clear(holdTimer)
    timer = null
    holdTimer = null
    setHolding(false)
  }

  const pendingOf = (results: SpeechResult[]) => results.slice(Math.min(consumed, results.length))

  const commit = (early: boolean) => {
    clearTimer()
    const waitedMs = Math.max(0, now() - lastResultAt)
    const text = joinTranscripts(pending.map((result) => result.transcript))
    consumed = lastLength
    pending = []
    options.onInterim?.('')
    if (isSpeakable(text, minChars)) options.onCommit(text, { waitedMs, early })
  }

  return {
    update(results) {
      lastLength = results.length
      pending = pendingOf(results)
      clearTimer()
      const text = joinTranscripts(pending.map((result) => result.transcript))
      options.onInterim?.(text)
      if (!text) return
      lastResultAt = now()
      const interim = pending.some((result) => !result.isFinal)
      const base = waitMs({ text, interim })
      const wait = Math.min(END_OF_TURN_CAP_MS, interim ? Math.max(base, staleInterimMs) : base)
      timer = timers.set(() => commit(false), wait)
      if (wait > holdAfterMs) holdTimer = timers.set(() => setHolding(true), holdAfterMs)
    },
    peek(results) {
      return joinTranscripts(pendingOf(results).map((result) => result.transcript))
    },
    skip(results) {
      clearTimer()
      consumed = results.length
      lastLength = results.length
      pending = []
      options.onInterim?.('')
    },
    flush() {
      if (pending.length > 0) commit(true)
      else clearTimer()
    },
    reset() {
      clearTimer()
      consumed = 0
      lastLength = 0
      pending = []
      options.onInterim?.('')
    },
    dispose() {
      clearTimer()
    },
  }
}

// ---- Echo --------------------------------------------------------------------------------

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * True when what the recognizer heard is (mostly) the coach's own voice coming back through
 * the speakers, so it must not count as the student talking over the coach.
 */
export function isEcho(heard: string, spoken: string): boolean {
  const heardWords = words(heard)
  const spokenWords = words(spoken)
  if (heardWords.length === 0 || spokenWords.length === 0) return false

  const heardJoined = ` ${heardWords.join(' ')} `
  const spokenJoined = ` ${spokenWords.join(' ')} `
  if (spokenJoined.includes(heardJoined)) return true

  if (heardWords.length < 3) return false
  const spokenSet = new Set(spokenWords)
  const matching = heardWords.filter((word) => spokenSet.has(word)).length
  return matching / heardWords.length >= 0.8
}

// ---- Idle --------------------------------------------------------------------------------

export type IdleAction = 'none' | 'gentle' | 'end'

/** Silence after the coach asked something, before the one gentle line (spec 19.8). Never earlier. */
export const GENTLE_AFTER_MS = 10_000
/** A talking student who stays silent this long since the coach finished has gone: end the session. */
export const VOICE_END_MS = 120_000
export const TEXT_END_MS = 10 * 60_000

/**
 * What to do when the student has been silent for `idleMs` since the coach last finished:
 * - a talking student gets one gentle line per question after 10 s (not a turn, nothing is recorded),
 *   and only when the coach is waiting for an answer;
 * - the session ends after a long silence; a typing student gets a much longer wait and no line,
 *   since typing is slow and silent.
 */
export function idleAction(input: {
  inputMode: 'voice' | 'text'
  idleMs: number
  /** The gentle line was already shown for this question. */
  gentleShown: boolean
  /** The coach asked something and waits (the server's `listen` is not `none`). */
  waitingForAnswer: boolean
}): IdleAction {
  if (input.inputMode === 'text') return input.idleMs >= TEXT_END_MS ? 'end' : 'none'
  if (input.idleMs >= VOICE_END_MS) return 'end'
  if (!input.gentleShown && input.waitingForAnswer && input.idleMs >= GENTLE_AFTER_MS) return 'gentle'
  return 'none'
}
