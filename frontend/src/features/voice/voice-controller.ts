/**
 * The imperative side of a voice practice: the session lifecycle, the turn stream, the recognizer,
 * speech output, heartbeat and idle handling. It reports what happens to the UI through
 * `dispatch` (see session-state.ts). No React in here, so the hook stays small.
 *
 * Rules it keeps:
 * - never two turns at once: turns run one after another on a promise chain
 * - barge-in cancels speech at once, aborts the open request and clears the sentence chunker
 * - a failed turn is retried with the same words, or with "" when a tool already ran
 * - the session is ended on End, on idle, on unmount and (with keepalive) on page hide
 */
import { isApiError, type ApiError } from '@/lib/api/client'
import { createSentenceChunker, readVoiceEvents, type SentenceChunker } from '@/lib/voice/turn-client'
import { speakable } from '@/lib/voice/speakable'
import { TURN_BUSY_WAIT_MS, TURN_STREAM_QUIET_MS, type ListenFor, type VoiceTurnExtras } from '@/lib/voice/turn-contract'
import { describeTurnFailure, type LobbyAlert, type TurnFailure } from './errors'
import { defaultListenFor, endOfTurnWaitMs } from './end-of-turn'
import { isBackchannel } from './backchannel'
import { fillerWaitMs, pickFiller } from './filler'
import { gentleLine } from './gentle'
import { buildMetrics, buildTiming, emptyClock, type TurnClock } from './turn-timing'
import { cleanTerms, enableOnDevice, onDeviceEnvFromWindow, onDeviceReady } from './on-device'
import { createHeardTracker, type HeardTracker } from './heard'
import { createMicMeter, type MicMeter } from './mic-meter'
import { canCaptureAudio, cloudRecognitionClass, createMicCapture, type MicCapture } from './cloud-recognition'
import { getVoicePrefs, resolveVoice, setVoicePrefs, subscribeVoicePrefs } from './voice-prefs'
import type { EndReason, InputMode, MicNotice, SessionAction } from './session-state'
import {
  createUtteranceCollector,
  idleAction,
  isEcho,
  type SpeechResult,
  type UtteranceCollector,
} from './silence'
import {
  createSpeaker,
  getRecognitionConstructor,
  hasSpeechSynthesis,
  isIosDevice,
  languageTag,
  resultsFromEvent,
  type RecognitionLike,
  type Speaker,
} from './speech'
import {
  createVoiceSession,
  getCloudSpeechGrant,
  openVoiceTurn,
  patchVoiceSession,
  postVoiceMetrics,
  requiresClaims,
  requiresGeneration,
  type VoiceStyle,
} from './voice-api'

export type StartConfig = {
  style: VoiceStyle
  language: string
  focus: string
  /** The idea a teach-back starts with. */
  conceptId?: string
  /** Start with the keyboard and the microphone off. */
  typed?: boolean
  /** End the voice practice that is open elsewhere and start this one. */
  takeOver?: boolean
}

export type VoiceControllerOptions = {
  courseId: string
  mode: 'topic' | 'sprint'
  topic?: { id: string; name: string }
}

export type VoiceControllerDeps = {
  dispatch: (action: SessionAction) => void
  options: VoiceControllerOptions
  /** The session reached the summary after at least one graded answer. */
  onFinished?: (reason: EndReason) => void
}

export type VoiceController = {
  meter: MicMeter
  /** The course and topic the next session is for (the props can change between sessions). */
  setOptions: (options: VoiceControllerOptions) => void
  /**
   * `opening` replaces the empty first turn: a session continued after a reload says what happened and which question to ask again.
   */
  start: (config: StartConfig, opening?: string | null) => Promise<void>
  /** What the open session was started with (null before the first start): a reload snapshot continues from it. */
  getConfig: () => StartConfig | null
  end: () => void
  /** Back to the lobby from the summary. */
  reset: () => void
  sendText: (text: string) => void
  /** Done: end the student's turn now, without waiting for the pause to run out. */
  done: () => void
  /** Stop the coach now (the Interrupt control): needed on iOS, where the recognizer cannot hear during speech. */
  interrupt: () => void
  toggleMic: () => void
  typeInstead: () => void
  enableMicrophone: () => Promise<void>
  toggleSpeech: () => void
  /** Say a short sample in the chosen voice and rate. */
  previewVoice: () => void
  hint: () => void
  skip: () => void
  retry: () => void
  dismissAlert: () => void
  /** The page is going away (pagehide): end the session with a keepalive request. */
  pageHide: () => void
  /** The component unmounted: stop everything and end the session. */
  dispose: () => void
}

/** What the voice settings say to let the student hear the voice and the pace. */
const VOICE_SAMPLE = 'This is how I sound.'
const HEARTBEAT_MS = 30_000
const ECHO_GRACE_MS = 1500
const MAX_UTTERANCE_CHARS = 2000

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

function failureFrom(error: unknown): TurnFailure {
  if (isApiError(error)) {
    const details = error.details as { retryable?: unknown } | undefined
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: typeof details?.retryable === 'boolean' ? details.retryable : error.status >= 500 || error.status === 0,
    }
  }
  return { code: 'VOICE_TURN_FAILED', message: '', retryable: true }
}

function lobbyAlertFor(error: unknown): LobbyAlert {
  if (requiresClaims(error)) return { kind: 'needs-claims' }
  if (requiresGeneration(error)) return { kind: 'needs-generation' }
  if (isApiError(error) && (error.details as { code?: unknown } | undefined)?.code === 'ACTIVE_SESSION') return { kind: 'busy' }
  if (isApiError(error)) {
    // A refusal with a voice code carries words written for the student (the coach is not reachable, the day's
    // allowance is used): those are shown. A bare 500 or 429 has none.
    const coded = typeof (error.details as { code?: unknown } | undefined)?.code === 'string'
    const text = coded
      ? error.message
      : error.status >= 500
        ? "We couldn't start the voice practice. Try again in a moment."
        : error.status === 429
          ? 'Too many requests. Wait a moment and try again.'
          : error.message
    return { kind: 'error', text }
  }
  return { kind: 'error', text: "We couldn't start the voice practice. Try again in a moment." }
}

/** The turn's clock, plus when the student's turn ended (the filler counts from there) and what has been reported. */
type Timing = TurnClock & {
  turnEnd: number
  /** What heard the answer that opened this turn (none when it was typed). */
  recognizer?: 'cloud' | 'device' | 'browser'
  /** The `timing` for the next request was made from this clock. */
  filed: boolean
  /** The metrics entry was posted. */
  posted: boolean
}

const newTiming = (): Timing => ({ ...emptyClock(), turnEnd: 0, filed: false, posted: false })

type Ctx = {
  sessionId: string | null
  generation: number
  ended: boolean
  abort: AbortController | null
  chain: Promise<void>
  turnId: number
  turnActive: boolean
  firstTurnDone: boolean
  toolRan: boolean
  completeSeen: boolean
  retry: { utterance: string } | null
  lastUtterance: string
  spokenText: string
  speakingNow: boolean
  speechEndedAt: number
  chunker: SentenceChunker
  speaker: Speaker | null
  /** What the student heard of the reply so far (for `interruptedHeard`). */
  heard: HeardTracker
  /** Sent with the next turn request, then cleared. */
  pending: VoiceTurnExtras
  speechOn: boolean
  recognition: RecognitionLike | null
  wantListening: boolean
  inputMode: InputMode
  micPaused: boolean
  lastResults: SpeechResult[]
  /** Words carried over from the run the browser ended on its own: they lead the new run's result list. */
  runPrefix: SpeechResult[]
  /** The topic's key terms from the server, and whether recognition runs on the device with them as phrases. */
  terms: string[]
  onDevice: boolean
  onDeviceChecked: boolean
  /** Cloud recognition (spec 19.12): the session's own microphone capture streams to the recognizer. */
  cloud: boolean
  capture: MicCapture | null
  cloudClass: (new () => RecognitionLike) | null
  /** The quiet already past when the recognizer closed the segment now being read: taken off the end-of-turn wait. */
  waitCredit: number
  segmentSilence: number | null
  /** What heard the last voice answer, for its turn's timing. */
  lastRecognizer: 'cloud' | 'device' | 'browser' | undefined
  /** Cloud providers whose stream refused this session; a refusal means the next one is tried before the browser's. */
  refusedProviders: string[]
  retryCloud: boolean
  /** iOS: recognition was stopped for the coach's voice and is made again when it is done. */
  suspended: boolean
  ios: boolean
  /** What the session is waiting for next (the server's `listen` event, else a guess from the style). */
  listenFor: ListenFor
  /** The turn in flight sent its own `listen` event. */
  listenSeen: boolean
  /** How long the quiet lasted after the last words of the answer that opened the next turn. */
  endpointWaitMs: number | null
  style: VoiceStyle
  restarts: number[]
  networkErrors: number
  /** Counts each time the microphone is asked on or off: opening it takes a moment, and only the latest ask counts. */
  micAsk: number
  heartbeat: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setInterval> | null
  idleSince: number
  /** The gentle line was shown for the question the coach last asked. */
  gentleShown: boolean
  timing: Timing
  /** When the reply sentence now playing started (for the speech time). */
  speakStartedAt: number | null
  /** The neutral line for a slow graded turn: said at most once per turn, never the same one twice in a row. */
  fillerDone: boolean
  fillerTimer: ReturnType<typeof setTimeout> | null
  lastFiller: string | null
  /** The filler said this turn: part of what the microphone may hear back, not part of the reply. */
  echoExtra: string
  /** When the answer that opens the next turn was sent. */
  turnEndedAt: number
  config: StartConfig | null
}

function freshCtx(generation: number): Ctx {
  return {
    sessionId: null,
    generation,
    ended: true,
    abort: null,
    chain: Promise.resolve(),
    turnId: 0,
    turnActive: false,
    firstTurnDone: false,
    toolRan: false,
    completeSeen: false,
    retry: null,
    lastUtterance: '',
    spokenText: '',
    speakingNow: false,
    speechEndedAt: 0,
    chunker: createSentenceChunker({ minChars: 12 }),
    speaker: null,
    heard: createHeardTracker(),
    pending: {},
    speechOn: true,
    recognition: null,
    wantListening: false,
    inputMode: 'voice',
    micPaused: false,
    lastResults: [],
    runPrefix: [],
    terms: [],
    onDevice: false,
    onDeviceChecked: false,
    cloud: false,
    capture: null,
    cloudClass: null,
    waitCredit: 0,
    segmentSilence: null,
    lastRecognizer: undefined,
    refusedProviders: [],
    retryCloud: false,
    suspended: false,
    ios: false,
    listenFor: 'short_answer',
    listenSeen: false,
    endpointWaitMs: null,
    style: 'oral_quiz',
    restarts: [],
    networkErrors: 0,
    micAsk: 0,
    heartbeat: null,
    idleTimer: null,
    idleSince: 0,
    gentleShown: false,
    timing: newTiming(),
    speakStartedAt: null,
    fillerDone: false,
    fillerTimer: null,
    lastFiller: null,
    echoExtra: '',
    turnEndedAt: 0,
    config: null,
  }
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const { dispatch } = deps
  const meter = createMicMeter()
  let options = deps.options
  let ctx = freshCtx(0)
  let unsubscribePrefs: (() => void) | null = null

  const collector: UtteranceCollector = createUtteranceCollector({
    // With cloud recognition a finished segment arrives after some quiet has already passed: only the rest is waited.
    waitMs: ({ text, interim }) =>
      Math.max(0, endOfTurnWaitMs({ listenFor: ctx.listenFor, text }) - (interim ? 0 : ctx.waitCredit)),
    onCommit: (text, info) => {
      if (ctx.ended || ctx.inputMode !== 'voice' || ctx.micPaused) return
      submit(text, { countInterrupt: false, via: 'voice', waitedMs: info.waitedMs })
    },
    onInterim: (text) => dispatch({ type: 'interim', text }),
    onHold: (on) => dispatch({ type: 'holding', on }),
  })

  // ---- Teardown --------------------------------------------------------------------------

  function clearTimers() {
    if (ctx.heartbeat) clearInterval(ctx.heartbeat)
    if (ctx.idleTimer) clearInterval(ctx.idleTimer)
    ctx.heartbeat = null
    ctx.idleTimer = null
  }

  /** Let go of the recognizer without forgetting the words heard so far. */
  function detachRecognition() {
    const recognition = ctx.recognition
    ctx.recognition = null
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.onstart = null
      try {
        recognition.abort()
      } catch {
        // already stopped
      }
    }
  }

  function stopRecognition() {
    detachRecognition()
    ctx.wantListening = false
    ctx.suspended = false
    collector.reset()
    ctx.lastResults = []
    ctx.runPrefix = []
  }

  /** The speech setting changed (in the lobby, the settings or the mute button): follow it. */
  function syncSpeechSetting() {
    if (ctx.ended || !ctx.speaker) return
    const on = getVoicePrefs().speak
    if (on === ctx.speechOn) return
    ctx.speechOn = on
    if (!on) ctx.speaker.cancel()
    dispatch({ type: 'speech', output: on ? 'on' : 'off' })
  }

  /** iOS stops listening in a page that is hidden (screen lock, another app) and does not come back by itself: make a new recognizer when it is shown again. */
  function onVisibilityChange() {
    if (!ctx.ios || ctx.cloud || ctx.ended || !ctx.wantListening) return
    if (document.hidden) {
      if (ctx.recognition) {
        detachRecognition()
        ctx.suspended = true
      }
    } else {
      resumeAfterSpeech()
    }
  }

  function teardown() {
    clearFiller()
    unsubscribePrefs?.()
    unsubscribePrefs = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
    ctx.ended = true
    ctx.turnId += 1
    ctx.abort?.abort()
    ctx.abort = null
    ctx.speaker?.cancel()
    stopRecognition()
    ctx.capture?.stop()
    meter.stop()
    clearTimers()
  }

  function finish(reason: EndReason, alert?: ReturnType<typeof describeTurnFailure>['alert'] | null, limitReached?: boolean) {
    if (ctx.ended) return
    const sessionId = ctx.sessionId
    teardown()
    // Every way out closes the call on the server, a finished drill included: the session stops counting as live (and its
    // minutes stop) now, not when its last heartbeat goes stale.
    if (sessionId) void patchVoiceSession({ sessionId, status: 'ended' })
    dispatch({ type: 'finish', reason, at: Date.now(), alert: alert ?? null, ...(limitReached ? { limitReached } : {}) })
    deps.onFinished?.(reason)
  }

  /** The session never really started (the first turn was refused): back to the lobby. */
  function abandonToLobby(lobbyAlert: LobbyAlert, limitReached?: boolean) {
    const sessionId = ctx.sessionId
    teardown()
    if (sessionId) void patchVoiceSession({ sessionId, status: 'ended' })
    dispatch({ type: 'start-failed', lobbyAlert, limitReached })
  }

  // ---- Input mode ------------------------------------------------------------------------

  function switchToText(notice?: MicNotice | null) {
    ctx.micAsk += 1
    stopRecognition()
    ctx.capture?.stop()
    meter.stop()
    ctx.inputMode = 'text'
    ctx.micPaused = false
    dispatch({ type: 'input-mode', mode: 'text', micNotice: notice })
  }

  /**
   * A new recognizer, every time: a reused one can go deaf in Chrome after many restarts, and on iOS
   * only a new one hears after the coach has spoken. `carry` is what the last run heard and the
   * student has not sent yet; it leads the new run's list, so the words are kept and the wait goes on.
   */
  function openRecognizer(carry = ''): boolean {
    const Recognition = ctx.cloud ? ctx.cloudClass : getRecognitionConstructor()
    if (!Recognition || !ctx.config) return false
    detachRecognition()
    ctx.wantListening = true
    ctx.runPrefix = carry ? [{ transcript: carry, isFinal: true }] : []
    ctx.lastResults = ctx.runPrefix
    collector.reset()
    if (carry) collector.update(ctx.runPrefix)
    // iOS hears nothing while the coach speaks, so a recognizer made now would be deaf: wait for the voice to finish.
    // The cloud recognizer listens through the page's own capture, which keeps hearing.
    if (ctx.ios && !ctx.cloud && ctx.speakingNow) {
      ctx.suspended = true
      return true
    }
    ctx.suspended = false
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = languageTag(ctx.config.language)
    recognition.maxAlternatives = 1
    if (ctx.onDevice && !ctx.cloud) {
      const env = onDeviceEnvFromWindow()
      if (!env || !enableOnDevice(recognition, env, ctx.terms)) ctx.onDevice = false
    }
    recognition.onresult = (event) => onResult(resultsFromEvent(event))
    recognition.onerror = (event) => onRecognitionError(event.error)
    recognition.onend = () => onRecognitionEnd(recognition)
    ctx.recognition = recognition
    try {
      recognition.start()
    } catch {
      return false
    }
    return true
  }

  function startRecognition(): boolean {
    stopRecognition()
    return openRecognizer()
  }

  /** What was heard and not yet sent, to lead the next run. */
  const pendingWords = () => {
    const words = collector.peek(ctx.lastResults)
    // A nod heard while the coach was talking was not the start of an answer.
    return (ctx.speakingNow || ctx.turnActive) && isBackchannel(words) ? '' : words
  }

  /** iOS: let go of the recognizer when the coach starts to speak (abort before, new one after). */
  function suspendForSpeech() {
    if (!ctx.ios || ctx.cloud || !ctx.wantListening || !ctx.recognition) return
    detachRecognition()
    ctx.suspended = true
  }

  /** iOS: the coach is done and no reply is still arriving: listen again with a new recognizer. */
  function resumeAfterSpeech() {
    if (!ctx.suspended || ctx.ended || ctx.speakingNow || ctx.turnActive) return
    const generation = ctx.generation
    setTimeout(() => {
      if (generation !== ctx.generation || ctx.ended || !ctx.suspended || !ctx.wantListening) return
      if (ctx.speakingNow || ctx.turnActive) return
      if (!openRecognizer(pendingWords())) switchToText('unstable')
    }, 300)
  }

  async function enableVoice(): Promise<void> {
    const generation = ctx.generation
    const ask = ++ctx.micAsk
    /**
     * The student paused the microphone, or chose to type, while it was still opening: this ask is over. Without the
     * check the microphone came on a moment later, with the button still saying it was paused. A newer ask to turn it
     * on owns the microphone now; otherwise what just opened is closed again.
     */
    const overtaken = () => {
      if (ask === ctx.micAsk) return false
      if (ctx.micPaused || ctx.inputMode === 'text') {
        ctx.capture?.stop()
        meter.stop()
      }
      return true
    }
    try {
      // Cloud recognition opens the microphone itself (and feeds the orb's level); otherwise the meter opens it.
      if (ctx.cloud && ctx.capture) await ctx.capture.start()
      else await meter.start()
    } catch (error) {
      if (generation !== ctx.generation || ctx.ended || overtaken()) return
      const name = (error as { name?: string } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') return switchToText('denied')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return switchToText('no-mic')
      // Cloud capture failed some other way (no audio worklet): the browser's recognizer takes over.
      if (ctx.cloud) {
        ctx.cloud = false
        ctx.capture?.stop()
        if (!getRecognitionConstructor()) return switchToText('unsupported')
      }
      // Any other failure only costs the level meter; the recognizer can still work.
    }
    if (generation !== ctx.generation || ctx.ended) {
      meter.stop()
      return
    }
    if (overtaken()) return
    ctx.inputMode = 'voice'
    ctx.micPaused = false
    ctx.networkErrors = 0
    dispatch({ type: 'input-mode', mode: 'voice' })
    // Once per session: on-device recognition with the course terms, only if the language pack is already installed.
    if (!ctx.cloud && !ctx.onDeviceChecked && ctx.config) {
      ctx.onDeviceChecked = true
      ctx.onDevice = await onDeviceReady(onDeviceEnvFromWindow(), languageTag(ctx.config.language))
      if (generation !== ctx.generation || ctx.ended || overtaken()) return
    }
    if (!startRecognition()) switchToText('unstable')
  }

  /** Stop using on-device recognition for this session and listen again the usual way, keeping the words so far. */
  function fallBackFromOnDevice() {
    ctx.onDevice = false
    if (!ctx.wantListening || ctx.suspended) return
    const carry = pendingWords()
    detachRecognition()
    setTimeout(() => {
      if (ctx.ended || ctx.recognition || !ctx.wantListening || ctx.suspended) return
      if (!openRecognizer(carry)) switchToText('unstable')
    }, 0)
  }

  /** A new cloud stream, with the next provider, keeping the words so far. */
  function retryCloudStream() {
    const carry = pendingWords()
    detachRecognition()
    setTimeout(() => {
      if (ctx.ended || ctx.recognition || !ctx.wantListening || ctx.suspended || ctx.micPaused || !ctx.cloud) return
      if (!openRecognizer(carry)) fallBackFromCloud()
    }, 0)
  }

  /** Stop using cloud recognition for this session: the browser's recognizer listens on, keeping the words so far. */
  function fallBackFromCloud() {
    ctx.cloud = false
    ctx.waitCredit = 0
    const carry = pendingWords()
    detachRecognition()
    ctx.capture?.stop()
    if (!getRecognitionConstructor()) {
      switchToText('unstable')
      return
    }
    dispatch({ type: 'recognizer', kind: 'browser' })
    setTimeout(() => {
      if (ctx.ended || ctx.recognition || !ctx.wantListening || ctx.suspended || ctx.micPaused) return
      if (!openRecognizer(carry)) switchToText('unstable')
    }, 0)
  }

  function onRecognitionError(code: string) {
    if (ctx.ended) return
    switch (code) {
      case 'cloud-unavailable':
        // One provider refused: ask for the next (the grant leaves the refused ones out). None left: the browser's.
        if (ctx.retryCloud) {
          ctx.retryCloud = false
          retryCloudStream()
        } else {
          fallBackFromCloud()
        }
        break
      case 'not-allowed':
      case 'service-not-allowed':
        switchToText('denied')
        break
      case 'audio-capture':
        switchToText('no-mic')
        break
      case 'language-not-supported':
      case 'phrases-not-supported':
        // On-device recognition lost its language pack, or phrases are refused: go on with the browser's usual recognizer.
        if (ctx.onDevice) {
          fallBackFromOnDevice()
          break
        }
        if (code === 'language-not-supported') switchToText('language')
        break
      case 'network':
        ctx.networkErrors += 1
        // The cloud stream dropped twice: go on with the browser's recognizer rather than reconnecting again.
        if (ctx.cloud && ctx.networkErrors >= 2) fallBackFromCloud()
        else if (ctx.networkErrors >= 3) switchToText('network')
        break
      default:
        // no-speech and aborted are routine; the recognizer restarts itself in onend.
        break
    }
  }

  function onRecognitionEnd(recognition: RecognitionLike) {
    if (ctx.recognition !== recognition) return
    if (!ctx.wantListening || ctx.ended) return
    const now = Date.now()
    ctx.restarts = [...ctx.restarts.filter((at) => now - at < 5000), now]
    if (ctx.restarts.length > 6) {
      switchToText('unstable')
      return
    }
    // The browser stopped on its own (a pause, 7-10 s of quiet): listen again at once. The words heard so
    // far stay, and so does the wait, so a thinking pause is not mistaken for a finished answer.
    ctx.recognition = null
    setTimeout(() => {
      if (ctx.recognition || !ctx.wantListening || ctx.ended || ctx.suspended) return
      if (!openRecognizer(pendingWords())) switchToText('unstable')
    }, 250)
  }

  function onResult(results: SpeechResult[]) {
    // The quiet the recognizer already waited out before closing this segment (cloud only), for this update's wait.
    ctx.waitCredit = ctx.segmentSilence ?? 0
    ctx.segmentSilence = null
    if (ctx.ended || ctx.inputMode !== 'voice' || ctx.micPaused) return
    const all = ctx.runPrefix.length > 0 ? [...ctx.runPrefix, ...results] : results
    ctx.lastResults = all
    const heard = collector.peek(all)
    if (!heard) return
    meter.bump()
    ctx.idleSince = Date.now()
    // Words arrived: the recognizer recovered. Only network errors in a row count towards giving up on the microphone
    // (three single drops over an hour once ended voice input for the rest of the session).
    ctx.networkErrors = 0

    const echoWindow = ctx.speakingNow || Date.now() - ctx.speechEndedAt < ECHO_GRACE_MS
    if (echoWindow && isEcho(heard, `${ctx.spokenText} ${speakable(ctx.spokenText)} ${ctx.echoExtra}`)) {
      collector.skip(all)
      return
    }
    if (ctx.turnActive || ctx.speakingNow) {
      // Too little to be a person talking (a click, a cough): ignore it.
      if (heard.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
        collector.skip(all)
        return
      }
      // A nod ("yeah", "mm-hm") is not an interruption. A final one is forgotten; an interim one waits, since it may grow into a sentence.
      if (isBackchannel(heard)) {
        if (all[all.length - 1]?.isFinal) collector.skip(all)
        return
      }
      bargeIn(true)
    }
    collector.update(all)
  }

  // ---- Speech output ---------------------------------------------------------------------

  function createSessionSpeaker(language: string): Speaker | null {
    if (!hasSpeechSynthesis()) return null
    return createSpeaker({
      lang: languageTag(language),
      rate: () => getVoicePrefs().rate,
      chooseVoice: (voices, lang) => resolveVoice(voices, lang, getVoicePrefs().voices[lang]),
      onSpeakingChange: (speaking) => {
        ctx.speakingNow = speaking
        if (speaking) suspendForSpeech()
        else resumeAfterSpeech()
        if (!speaking) ctx.speechEndedAt = Date.now()
        dispatch({ type: 'speaking', on: speaking })
      },
      onStart: (item) => {
        // The first audio of the reply, not a filler line or a sample.
        if (item.display !== undefined && ctx.timing.firstSpeak === null) ctx.timing.firstSpeak = performance.now()
      },
      onEvent: (event) => {
        if (event.item.display === undefined) return
        if (event.type === 'start') {
          ctx.heard.start(event.item.display, event.item.speech)
          ctx.speakStartedAt = performance.now()
        } else if (event.type === 'boundary') {
          ctx.heard.boundary(event.charIndex)
        } else {
          if (event.type === 'end') ctx.heard.finish()
          else ctx.heard.abandon()
          closeSpeechSpan()
        }
      },
      onUnavailable: () => {
        ctx.speechOn = false
        dispatch({ type: 'speech', output: 'unsupported' })
      },
    })
  }

  // ---- Turns -----------------------------------------------------------------------------

  function queueTurn(utterance: string) {
    ctx.chain = ctx.chain.then(() => runTurn(utterance)).catch(() => undefined)
  }

  function stopIdle() {
    if (ctx.idleTimer) clearInterval(ctx.idleTimer)
    ctx.idleTimer = null
  }

  function startIdle() {
    stopIdle()
    ctx.idleSince = Date.now()
    ctx.idleTimer = setInterval(() => {
      if (ctx.ended || ctx.turnActive || ctx.speakingNow) {
        ctx.idleSince = Date.now()
        return
      }
      const action = idleAction({
        inputMode: ctx.inputMode === 'voice' && !ctx.micPaused ? 'voice' : 'text',
        idleMs: Date.now() - ctx.idleSince,
        gentleShown: ctx.gentleShown,
        waitingForAnswer: ctx.listenFor !== 'none',
      })
      if (action === 'gentle') {
        sayGentleLine()
      } else if (action === 'end') {
        finish('idle')
      }
    }, 2000)
  }

  /** One gentle line per question: shown, and spoken when speech is on. It is not a turn and nothing is sent. */
  function sayGentleLine() {
    ctx.gentleShown = true
    const line = gentleLine(ctx.config?.language ?? 'en')
    ctx.echoExtra = `${ctx.echoExtra} ${line}`
    dispatch({ type: 'note', text: line })
    if (ctx.speechOn && ctx.speaker) ctx.speaker.enqueue({ speech: line })
  }

  /** After the coach finished (reply complete and speech drained). */
  function afterCoach(turnId: number) {
    const speaker = ctx.speaker
    const idle = speaker ? speaker.whenIdle() : Promise.resolve()
    void idle.then(() => {
      if (ctx.ended || ctx.turnId !== turnId || ctx.turnActive) return
      if (ctx.completeSeen) {
        finish('complete')
        return
      }
      startIdle()
    })
  }

  // ---- Timing --------------------------------------------------------------------------------

  /** The reply sentence that was playing has stopped (finished or cut off): count its time. */
  function closeSpeechSpan() {
    if (ctx.speakStartedAt === null) return
    ctx.timing.speechMs += performance.now() - ctx.speakStartedAt
    ctx.speakStartedAt = null
  }

  /** Make the `timing` that goes with the next turn request from this turn's clock. */
  function fileTiming(clock: Timing) {
    if (clock.start === 0) return
    ctx.pending = { ...ctx.pending, timing: { ...buildTiming(clock), ...(clock.recognizer ? { recognizer: clock.recognizer } : {}) } }
    clock.filed = true
  }

  /** Post the turn's metrics entry, once. */
  function postTurnMetrics(sessionId: string, clock: Timing) {
    if (clock.posted || clock.start === 0) return
    clock.posted = true
    postVoiceMetrics(sessionId, buildMetrics(clock))
  }

  // ---- No silent graded turn -----------------------------------------------------------------

  function clearFiller() {
    if (ctx.fillerTimer) clearTimeout(ctx.fillerTimer)
    ctx.fillerTimer = null
  }

  /** The first sentence of the reply is here: no filler is needed any more. */
  function noteFirstSentence() {
    if (ctx.timing.firstSentence === null) ctx.timing.firstSentence = performance.now()
    clearFiller()
  }

  /** The server started a graded step. If no sentence is in 1.2 s after the turn ended, say one neutral line. */
  function armFiller() {
    if (ctx.fillerDone || ctx.timing.firstSentence !== null) return
    ctx.fillerDone = true
    const turnId = ctx.turnId
    const generation = ctx.generation
    clearFiller()
    ctx.fillerTimer = setTimeout(() => {
      ctx.fillerTimer = null
      if (ctx.ended || ctx.generation !== generation || ctx.turnId !== turnId || !ctx.turnActive) return
      if (ctx.timing.firstSentence !== null) return
      const line = pickFiller(ctx.config?.language ?? 'en', ctx.lastFiller)
      ctx.lastFiller = line
      ctx.echoExtra = line
      // Shown as text, and spoken when speech is on. It is not part of the reply the server stores.
      dispatch({ type: 'coach-text', delta: `${line} ` })
      if (ctx.speechOn && ctx.speaker) ctx.speaker.enqueue({ speech: line })
    }, fillerWaitMs(ctx.timing.turnEnd, performance.now()))
  }

  function speakSentences(sentences: string[]) {
    if (sentences.length > 0) noteFirstSentence()
    if (!ctx.speechOn || !ctx.speaker) return
    for (const sentence of sentences) ctx.speaker.enqueue({ speech: speakable(sentence), display: sentence })
  }

  function failTurn(failure: TurnFailure, utterance: string) {
    const view = describeTurnFailure(failure)
    clearFiller()
    ctx.turnActive = false
    resumeAfterSpeech()

    if (failure.code === 'VOICE_NOT_SAVED') {
      // The reply itself was fine: treat the turn as done and tell the student.
      ctx.firstTurnDone = true
      speakSentences(ctx.chunker.flush())
      dispatch({ type: 'turn-failed', alert: view.alert })
      afterCoach(ctx.turnId)
      return
    }

    if (!ctx.firstTurnDone && view.fate !== 'continue') {
      // Two starts at the same moment: the other one won, and the lobby offers to take over from it.
      abandonToLobby(failure.code === 'ACTIVE_SESSION' ? { kind: 'busy' } : { kind: 'turn', alert: view.alert }, view.limitReached)
      return
    }
    // A refusal that sends a first turn back to the lobby (the day's voice time is used, another session is open) ends a
    // session that is under way: it cannot go on, and the summary says why.
    if (view.fate === 'summary' || view.fate === 'lobby') {
      finish(failure.code === 'SESSION_ENDED' || failure.code === 'NOT_FOUND' ? 'ended' : 'error', view.alert, view.limitReached)
      return
    }
    // The server kept this turn when a step ran or the coach had started to speak: "try again" then carries on from
    // there. Otherwise nothing was kept and the same words go again.
    ctx.retry = view.alert.action === 'retry' ? { utterance: ctx.toolRan || ctx.spokenText.trim() ? '' : utterance } : null
    dispatch({ type: 'turn-failed', alert: view.alert })
  }

  async function runTurn(utterance: string): Promise<void> {
    const sessionId = ctx.sessionId
    if (ctx.ended || !sessionId) return
    const generation = ctx.generation
    const turnId = ++ctx.turnId
    const stale = () => ctx.generation !== generation || ctx.turnId !== turnId || ctx.ended

    ctx.turnActive = true
    ctx.toolRan = false
    ctx.listenSeen = false
    ctx.gentleShown = false
    ctx.spokenText = ''
    ctx.heard.reset()
    ctx.lastUtterance = utterance
    ctx.chunker = createSentenceChunker({ minChars: 12 })
    const startedAt = performance.now()
    ctx.timing = {
      ...newTiming(),
      start: startedAt,
      turnEnd: ctx.turnEndedAt || startedAt,
      endpointWaitMs: ctx.endpointWaitMs,
      recognizer: ctx.lastRecognizer,
    }
    ctx.lastRecognizer = undefined
    ctx.endpointWaitMs = null
    ctx.speakStartedAt = null
    ctx.turnEndedAt = 0
    ctx.fillerDone = false
    ctx.echoExtra = ''
    clearFiller()
    stopIdle()
    dispatch({ type: 'turn-started' })

    const controller = new AbortController()
    ctx.abort = controller

    let response: Response | null = null
    // The session's last turn may still hold it: one this browser just cut off is finishing on the server, or its
    // server died and the claim has to go stale. Wait as long as a dead claim can last, then say so.
    const busyUntil = Date.now() + TURN_BUSY_WAIT_MS
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await openVoiceTurn(sessionId, utterance, controller.signal, ctx.pending)
        // The server has taken what went with the request (it keeps an interruption mark before it answers).
        ctx.pending = {}
        break
      } catch (error) {
        if (isAbort(error) || stale()) return
        const failure = failureFrom(error as ApiError)
        if (failure.code === 'TURN_IN_PROGRESS' && Date.now() < busyUntil) {
          await sleep(Math.min(3000, 700 + attempt * 300), controller.signal)
          if (stale()) return
          continue
        }
        failTurn(failure, utterance)
        return
      }
    }
    if (!response?.body) {
      failTurn({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }, utterance)
      return
    }

    let terminal = false
    try {
      for await (const event of readVoiceEvents(response.body, { quietMs: TURN_STREAM_QUIET_MS })) {
        if (stale()) return
        const eventAt = performance.now()
        if (ctx.timing.firstEvent === null) ctx.timing.firstEvent = eventAt
        // The first thing after "working" ends the graded step as the browser sees it.
        if (ctx.timing.workingAt !== null && ctx.timing.afterWorkingAt === null && event.type !== 'working' && event.type !== 'listen') ctx.timing.afterWorkingAt = eventAt
        switch (event.type) {
          case 'text':
            if (ctx.timing.firstText === null) ctx.timing.firstText = performance.now()
            ctx.spokenText += event.delta
            dispatch({ type: 'coach-text', delta: event.delta })
            speakSentences(ctx.chunker.push(event.delta))
            break
          case 'retract':
            // The reply just streamed was cut off at its token limit and is being asked again: the unspoken tail of it
            // (what the chunker still holds) is never spoken. Sentences already spoken were whole.
            ctx.chunker = createSentenceChunker({ minChars: 12 })
            break
          case 'question':
            ctx.toolRan = true
            dispatch({
              type: 'question',
              question: {
                // The server counts from zero (the question's place in the set); people count from one.
                index: event.total > 0 ? Math.min(event.index + 1, event.total) : event.index + 1,
                total: event.total,
                text: event.text,
                options: event.options,
              },
            })
            break
          case 'idea_done':
            ctx.toolRan = true
            dispatch({ type: 'idea-done', idea: { name: event.name, outcome: event.outcome, conceptId: event.conceptId ?? null, lookAgain: event.lookAgain ?? [], lookLinks: event.lookLinks ?? [] } })
            break
          case 'board':
            ctx.toolRan = true
            dispatch({ type: 'board', board: { kind: event.kind, text: event.text, question: event.question, source: event.source, idea: event.idea } })
            break
          case 'evaluation':
            ctx.toolRan = true
            dispatch({
              type: 'evaluation',
              evaluation: {
                isCorrect: event.isCorrect,
                score: event.score,
                comment: event.comment,
                explanation: event.explanation,
                ungraded: event.ungraded === true,
                ...(event.lookLinks ? { lookLinks: event.lookLinks } : {}),
              },
            })
            break
          case 'hint':
            ctx.toolRan = true
            dispatch({ type: 'hint', text: event.text })
            break
          case 'working':
            if (ctx.timing.workingAt === null) ctx.timing.workingAt = performance.now()
            armFiller()
            break
          case 'listen':
            ctx.listenFor = event.for
            ctx.listenSeen = true
            break
          case 'session_complete':
            ctx.completeSeen = true
            dispatch({ type: 'session-complete' })
            break
          case 'done': {
            terminal = true
            speakSentences(ctx.chunker.flush())
            ctx.turnActive = false
            clearFiller()
            ctx.firstTurnDone = true
            if (!ctx.listenSeen) ctx.listenFor = defaultListenFor(ctx.style)
            ctx.retry = null
            dispatch({ type: 'turn-done' })
            resumeAfterSpeech()
            const clock = ctx.timing
            clock.doneAt = performance.now()
            fileTiming(clock)
            // The metrics entry waits for the reply audio to finish, so it can say how long the coach spoke.
            void (ctx.speaker ? ctx.speaker.whenIdle() : Promise.resolve()).then(() => postTurnMetrics(sessionId, clock))
            afterCoach(turnId)
            break
          }
          case 'error':
            terminal = true
            speakSentences(ctx.chunker.flush())
            failTurn({ code: event.code, message: event.message, retryable: event.retryable }, utterance)
            break
        }
      }
    } catch (error) {
      if (isAbort(error) || stale()) return
      // A stream that stalled is dropped for good, so the server stops the turn and frees the session for the retry.
      controller.abort()
      failTurn({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }, utterance)
      return
    }
    if (stale()) return
    if (!terminal) failTurn({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }, utterance)
  }

  /** Note what the student heard of the reply that is being cut off, to send with the next turn. */
  function rememberInterruption() {
    const heard = (ctx.speechOn && ctx.speaker ? ctx.heard.text() : ctx.spokenText.trim()).slice(0, MAX_UTTERANCE_CHARS)
    ctx.pending = { ...ctx.pending, ...(heard ? { interruptedHeard: heard } : {}) }
  }

  function bargeIn(countInterrupt: boolean) {
    if (ctx.turnActive || ctx.speakingNow) {
      rememberInterruption()
      // The turn being cut off still reports: its timing goes with the next request, its metrics now.
      const clock = ctx.timing
      clock.interrupted = true
      closeSpeechSpan()
      if (!clock.filed) fileTiming(clock)
      else if (ctx.pending.timing) ctx.pending = { ...ctx.pending, timing: { ...ctx.pending.timing, interrupted: true } }
      if (ctx.sessionId) postTurnMetrics(ctx.sessionId, clock)
    }
    clearFiller()
    ctx.turnId += 1
    ctx.abort?.abort()
    ctx.abort = null
    ctx.speaker?.cancel()
    ctx.chunker = createSentenceChunker({ minChars: 12 })
    ctx.turnActive = false
    stopIdle()
    dispatch({ type: 'turn-aborted' })
    if (countInterrupt && ctx.sessionId) {
      void patchVoiceSession({ sessionId: ctx.sessionId, incrementInterruptCount: 1 })
    }
    if (ctx.completeSeen) finish('complete')
  }

  function submit(text: string, options: { countInterrupt: boolean; via: 'voice' | 'text'; waitedMs?: number }) {
    if (ctx.ended || !ctx.sessionId) return
    const clean = text.trim().slice(0, MAX_UTTERANCE_CHARS)
    if (!clean) return
    if (ctx.turnActive || ctx.speakingNow) bargeIn(options.countInterrupt)
    if (ctx.ended) return

    ctx.retry = null
    // New words: a retry mark left by a "try again" that never reached the server does not apply to them.
    if (ctx.pending.retry) ctx.pending = { ...ctx.pending, retry: undefined }
    ctx.lastRecognizer = options.via === 'voice' ? (ctx.cloud ? 'cloud' : ctx.onDevice ? 'device' : 'browser') : undefined
    ctx.endpointWaitMs = options.waitedMs ?? null
    ctx.turnEndedAt = performance.now()
    dispatch({ type: 'student-said', text: clean, via: options.via })
    queueTurn(clean)
  }

  // ---- Public API ------------------------------------------------------------------------

  async function start(config: StartConfig, opening?: string | null): Promise<void> {
    if (options.mode === 'topic' && !options.topic) {
      dispatch({ type: 'start-failed', lobbyAlert: { kind: 'error', text: 'Pick a topic to review first.' } })
      return
    }
    dispatch({ type: 'starting' })

    let created
    try {
      created = await createVoiceSession({
        projectId: options.courseId,
        mode: options.mode === 'sprint' ? 'sprint' : 'topic_drill',
        ...(options.mode === 'topic' ? { topicId: options.topic?.id } : {}),
        style: options.mode === 'sprint' ? 'oral_quiz' : config.style,
        focus: config.focus.trim() ? config.focus.trim() : null,
        ...(config.conceptId ? { conceptId: config.conceptId } : {}),
        language: config.language,
        ...(config.takeOver ? { takeOver: true } : {}),
      })
    } catch (error) {
      dispatch({ type: 'start-failed', lobbyAlert: lobbyAlertFor(error) })
      return
    }

    const generation = ctx.generation + 1
    ctx = freshCtx(generation)
    ctx.sessionId = created.sessionId
    ctx.ended = false
    ctx.config = config
    ctx.terms = cleanTerms(created.courseTerms)
    ctx.style = options.mode === 'sprint' ? 'oral_quiz' : config.style
    ctx.listenFor = defaultListenFor(ctx.style)
    ctx.ios = isIosDevice()
    // Cloud recognition when the server offers it, the student has not turned it off, and this browser can capture audio.
    ctx.cloud = created.cloudSpeech === true && getVoicePrefs().recognition === 'cloud' && canCaptureAudio()
    if (ctx.cloud) {
      const sessionId = created.sessionId
      ctx.capture = createMicCapture()
      // The microphone went away and would not come back: the browser's recognizer tries with its own capture (and
      // reports "no microphone" if it cannot hear either), so the screen never says "Listening" to a dead mic.
      const captureGeneration = generation
      ctx.capture.onFailed(() => {
        if (captureGeneration !== ctx.generation || ctx.ended || !ctx.cloud || ctx.inputMode !== 'voice') return
        fallBackFromCloud()
      })
      ctx.cloudClass = cloudRecognitionClass({
        capture: ctx.capture,
        grant: () => getCloudSpeechGrant(sessionId, ctx.refusedProviders),
        onRefused: (provider) => {
          if (ctx.refusedProviders.includes(provider)) return
          ctx.refusedProviders = [...ctx.refusedProviders, provider]
          ctx.retryCloud = true
        },
        onSegmentEnd: (silenceMs) => {
          ctx.segmentSilence = silenceMs
        },
        onLevel: (level) => meter.bump(level),
      })
    }
    ctx.speaker = createSessionSpeaker(config.language)
    unsubscribePrefs?.()
    unsubscribePrefs = subscribeVoicePrefs(syncSpeechSetting)
    document.addEventListener('visibilitychange', onVisibilityChange)

    const recognitionAvailable = ctx.cloud || getRecognitionConstructor() !== null
    // "Start by typing" in the lobby: no microphone, so no audio goes anywhere. The student can turn the mic on later.
    const startVoice = recognitionAvailable && !config.typed
    ctx.inputMode = startVoice ? 'voice' : 'text'
    ctx.speechOn = ctx.speaker !== null && getVoicePrefs().speak
    dispatch({
      type: 'started',
      at: Date.now(),
      style: options.mode === 'sprint' ? 'oral_quiz' : config.style,
      language: config.language,
      inputMode: ctx.inputMode,
      speech: !ctx.speaker ? 'unsupported' : ctx.speechOn ? 'on' : 'off',
      micNotice: recognitionAvailable ? null : 'unsupported',
      recognizer: ctx.cloud ? 'cloud' : 'browser',
    })

    ctx.heartbeat = setInterval(() => {
      if (ctx.sessionId && !ctx.ended) void patchVoiceSession({ sessionId: ctx.sessionId, heartbeat: true })
    }, HEARTBEAT_MS)

    if (startVoice) void enableVoice()
    queueTurn(opening ?? '')
  }

  async function enableMicrophone(): Promise<void> {
    if (ctx.ended || !(ctx.cloud || getRecognitionConstructor())) return
    await enableVoice()
  }

  return {
    meter,
    setOptions(next) {
      options = next
    },
    start,
    getConfig: () => ctx.config,
    enableMicrophone,

    end() {
      finish('user')
    },

    reset() {
      dispatch({ type: 'reset' })
    },

    sendText(text) {
      submit(text, { countInterrupt: false, via: 'text' })
    },

    interrupt() {
      if (ctx.ended || !(ctx.turnActive || ctx.speakingNow)) return
      bargeIn(true)
      if (!ctx.ended) startIdle()
    },

    done() {
      if (ctx.ended || ctx.inputMode !== 'voice' || ctx.micPaused) return
      collector.flush()
    },

    toggleMic() {
      if (ctx.ended) return
      if (ctx.inputMode === 'text') {
        void enableMicrophone()
        return
      }
      if (ctx.micPaused) {
        ctx.micPaused = false
        dispatch({ type: 'mic-paused', paused: false })
        void enableVoice()
      } else {
        ctx.micPaused = true
        ctx.micAsk += 1
        stopRecognition()
        ctx.capture?.stop()
        meter.stop()
        dispatch({ type: 'mic-paused', paused: true })
      }
    },

    typeInstead() {
      if (ctx.ended) return
      switchToText()
    },

    toggleSpeech() {
      if (ctx.ended || !ctx.speaker) return
      setVoicePrefs({ speak: !getVoicePrefs().speak })
    },

    previewVoice() {
      if (ctx.ended || !ctx.speaker || !getVoicePrefs().speak || ctx.speaker.busy || ctx.turnActive) return
      ctx.spokenText += ` ${VOICE_SAMPLE}`
      ctx.speaker.enqueue(VOICE_SAMPLE)
    },

    hint() {
      submit('Can I have a hint?', { countInterrupt: false, via: 'text' })
    },

    skip() {
      submit('Skip this question and ask me the next one.', { countInterrupt: false, via: 'text' })
    },

    retry() {
      if (ctx.ended || !ctx.retry || ctx.turnActive) return
      const { utterance } = ctx.retry
      ctx.retry = null
      if (utterance) ctx.pending = { ...ctx.pending, retry: true }
      dispatch({ type: 'dismiss-alert' })
      queueTurn(utterance)
    },

    dismissAlert() {
      dispatch({ type: 'dismiss-alert' })
    },

    pageHide() {
      if (ctx.sessionId && !ctx.ended) {
        void patchVoiceSession({ sessionId: ctx.sessionId, status: 'ended' }, { keepalive: true })
      }
    },

    dispose() {
      const sessionId = ctx.sessionId
      const wasOpen = !ctx.ended
      teardown()
      if (sessionId && wasOpen) void patchVoiceSession({ sessionId, status: 'ended' }, { keepalive: true })
    },
  }
}
