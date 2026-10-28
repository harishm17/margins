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
import { describeTurnFailure, type LobbyAlert, type TurnFailure } from './errors'
import { createMicMeter, type MicMeter } from './mic-meter'
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
  languageTag,
  resultsFromEvent,
  type RecognitionLike,
  type Speaker,
} from './speech'
import {
  createVoiceSession,
  openVoiceTurn,
  patchVoiceSession,
  postVoiceMetrics,
  requiresGeneration,
  type VoiceStyle,
} from './voice-api'

export type StartConfig = { style: VoiceStyle; language: string; focus: string }

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
  start: (config: StartConfig) => Promise<void>
  end: () => void
  /** Back to the lobby from the summary. */
  reset: () => void
  sendText: (text: string) => void
  toggleMic: () => void
  typeInstead: () => void
  enableMicrophone: () => Promise<void>
  toggleSpeech: () => void
  hint: () => void
  skip: () => void
  retry: () => void
  dismissAlert: () => void
  /** The page is going away (pagehide): end the session with a keepalive request. */
  pageHide: () => void
  /** The component unmounted: stop everything and end the session. */
  dispose: () => void
}

const HEARTBEAT_MS = 30_000
const ECHO_GRACE_MS = 1500
const MAX_UTTERANCE_CHARS = 2000
const TURN_IN_PROGRESS_RETRIES = 6

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
  if (requiresGeneration(error)) return { kind: 'needs-generation' }
  if (isApiError(error)) {
    const text =
      error.status >= 500
        ? "We couldn't start the voice practice. Try again in a moment."
        : error.status === 429
          ? 'Too many requests. Wait a moment and try again.'
          : error.message
    return { kind: 'error', text }
  }
  return { kind: 'error', text: "We couldn't start the voice practice. Try again in a moment." }
}

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
  speechOn: boolean
  recognition: RecognitionLike | null
  wantListening: boolean
  inputMode: InputMode
  micPaused: boolean
  lastResults: SpeechResult[]
  restarts: number[]
  networkErrors: number
  heartbeat: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setInterval> | null
  idleSince: number
  nudged: boolean
  timing: { start: number; firstText: number | null; firstSpeak: number | null }
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
    speechOn: true,
    recognition: null,
    wantListening: false,
    inputMode: 'voice',
    micPaused: false,
    lastResults: [],
    restarts: [],
    networkErrors: 0,
    heartbeat: null,
    idleTimer: null,
    idleSince: 0,
    nudged: false,
    timing: { start: 0, firstText: null, firstSpeak: null },
    config: null,
  }
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const { dispatch } = deps
  const meter = createMicMeter()
  let options = deps.options
  let ctx = freshCtx(0)

  const collector: UtteranceCollector = createUtteranceCollector({
    onCommit: (text) => {
      if (ctx.ended || ctx.inputMode !== 'voice' || ctx.micPaused) return
      submit(text, { countInterrupt: false })
    },
    onInterim: (text) => dispatch({ type: 'interim', text }),
  })

  // ---- Teardown --------------------------------------------------------------------------

  function clearTimers() {
    if (ctx.heartbeat) clearInterval(ctx.heartbeat)
    if (ctx.idleTimer) clearInterval(ctx.idleTimer)
    ctx.heartbeat = null
    ctx.idleTimer = null
  }

  function stopRecognition() {
    const recognition = ctx.recognition
    ctx.recognition = null
    ctx.wantListening = false
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
    collector.reset()
    ctx.lastResults = []
  }

  function teardown() {
    ctx.ended = true
    ctx.turnId += 1
    ctx.abort?.abort()
    ctx.abort = null
    ctx.speaker?.cancel()
    stopRecognition()
    meter.stop()
    clearTimers()
  }

  function finish(reason: EndReason, alert?: ReturnType<typeof describeTurnFailure>['alert'] | null) {
    if (ctx.ended) return
    const sessionId = ctx.sessionId
    teardown()
    if (sessionId && reason !== 'complete' && reason !== 'ended') {
      void patchVoiceSession({ sessionId, status: 'ended' })
    }
    dispatch({ type: 'finish', reason, at: Date.now(), alert: alert ?? null })
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
    stopRecognition()
    meter.stop()
    ctx.inputMode = 'text'
    ctx.micPaused = false
    dispatch({ type: 'input-mode', mode: 'text', micNotice: notice })
  }

  function startRecognition(): boolean {
    const Recognition = getRecognitionConstructor()
    if (!Recognition || !ctx.config) return false
    stopRecognition()
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = languageTag(ctx.config.language)
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => onResult(resultsFromEvent(event))
    recognition.onerror = (event) => onRecognitionError(event.error)
    recognition.onend = () => onRecognitionEnd(recognition)
    ctx.recognition = recognition
    ctx.wantListening = true
    try {
      recognition.start()
    } catch {
      return false
    }
    return true
  }

  async function enableVoice(): Promise<void> {
    const generation = ctx.generation
    try {
      await meter.start()
    } catch (error) {
      if (generation !== ctx.generation || ctx.ended) return
      const name = (error as { name?: string } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') return switchToText('denied')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return switchToText('no-mic')
      // Any other failure only costs the level meter; the recognizer can still work.
    }
    if (generation !== ctx.generation || ctx.ended) {
      meter.stop()
      return
    }
    ctx.inputMode = 'voice'
    ctx.micPaused = false
    ctx.networkErrors = 0
    dispatch({ type: 'input-mode', mode: 'voice' })
    if (!startRecognition()) switchToText('unstable')
  }

  function onRecognitionError(code: string) {
    if (ctx.ended) return
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
        switchToText('denied')
        break
      case 'audio-capture':
        switchToText('no-mic')
        break
      case 'language-not-supported':
        switchToText('language')
        break
      case 'network':
        ctx.networkErrors += 1
        if (ctx.networkErrors >= 3) switchToText('network')
        break
      default:
        // no-speech and aborted are routine; the recognizer restarts itself in onend.
        break
    }
  }

  function onRecognitionEnd(recognition: RecognitionLike) {
    if (ctx.recognition !== recognition) return
    collector.flush()
    collector.reset()
    ctx.lastResults = []
    if (!ctx.wantListening || ctx.ended) return
    const now = Date.now()
    ctx.restarts = [...ctx.restarts.filter((at) => now - at < 5000), now]
    if (ctx.restarts.length > 6) {
      switchToText('unstable')
      return
    }
    setTimeout(() => {
      if (ctx.recognition !== recognition || !ctx.wantListening || ctx.ended) return
      try {
        recognition.start()
      } catch {
        switchToText('unstable')
      }
    }, 250)
  }

  function onResult(results: SpeechResult[]) {
    if (ctx.ended || ctx.inputMode !== 'voice' || ctx.micPaused) return
    ctx.lastResults = results
    const heard = collector.peek(results)
    if (!heard) return
    meter.bump()
    ctx.idleSince = Date.now()

    const echoWindow = ctx.speakingNow || Date.now() - ctx.speechEndedAt < ECHO_GRACE_MS
    if (echoWindow && isEcho(heard, ctx.spokenText)) {
      collector.skip(results)
      return
    }
    if (ctx.turnActive || ctx.speakingNow) {
      // Too little to be a person talking (a click, a cough): ignore it.
      if (heard.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
        collector.skip(results)
        return
      }
      bargeIn(true)
    }
    collector.update(results)
  }

  // ---- Speech output ---------------------------------------------------------------------

  function createSessionSpeaker(language: string): Speaker | null {
    if (!hasSpeechSynthesis()) return null
    return createSpeaker({
      lang: languageTag(language),
      rate: 1,
      onSpeakingChange: (speaking) => {
        ctx.speakingNow = speaking
        if (!speaking) ctx.speechEndedAt = Date.now()
        dispatch({ type: 'speaking', on: speaking })
      },
      onStart: () => {
        if (ctx.timing.firstSpeak === null) ctx.timing.firstSpeak = performance.now()
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
        nudged: ctx.nudged,
      })
      if (action === 'nudge') {
        ctx.nudged = true
        stopIdle()
        queueTurn('')
      } else if (action === 'end') {
        finish('idle')
      }
    }, 2000)
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

  function speakSentences(sentences: string[]) {
    if (!ctx.speechOn || !ctx.speaker) return
    for (const sentence of sentences) ctx.speaker.enqueue(sentence)
  }

  function failTurn(failure: TurnFailure, utterance: string) {
    const view = describeTurnFailure(failure)
    ctx.turnActive = false

    if (failure.code === 'VOICE_NOT_SAVED') {
      // The reply itself was fine: treat the turn as done and tell the student.
      ctx.firstTurnDone = true
      speakSentences(ctx.chunker.flush())
      dispatch({ type: 'turn-failed', alert: view.alert })
      afterCoach(ctx.turnId)
      return
    }

    if (!ctx.firstTurnDone && view.fate !== 'continue') {
      abandonToLobby({ kind: 'turn', alert: view.alert }, view.limitReached)
      return
    }
    if (view.fate === 'summary') {
      finish(failure.code === 'SESSION_ENDED' || failure.code === 'NOT_FOUND' ? 'ended' : 'error', view.alert)
      return
    }
    ctx.retry = view.alert.action === 'retry' ? { utterance: ctx.toolRan ? '' : utterance } : null
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
    ctx.spokenText = ''
    ctx.lastUtterance = utterance
    ctx.chunker = createSentenceChunker({ minChars: 12 })
    ctx.timing = { start: performance.now(), firstText: null, firstSpeak: null }
    stopIdle()
    dispatch({ type: 'turn-started' })

    const controller = new AbortController()
    ctx.abort = controller

    let response: Response | null = null
    for (let attempt = 0; attempt <= TURN_IN_PROGRESS_RETRIES; attempt += 1) {
      try {
        response = await openVoiceTurn(sessionId, utterance, controller.signal)
        break
      } catch (error) {
        if (isAbort(error) || stale()) return
        const failure = failureFrom(error as ApiError)
        // A turn we just aborted is still finishing on the server: wait for it and try again.
        if (failure.code === 'TURN_IN_PROGRESS' && attempt < TURN_IN_PROGRESS_RETRIES) {
          await sleep(700 + attempt * 300, controller.signal)
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
      for await (const event of readVoiceEvents(response.body)) {
        if (stale()) return
        switch (event.type) {
          case 'text':
            if (ctx.timing.firstText === null) ctx.timing.firstText = performance.now()
            ctx.spokenText += event.delta
            dispatch({ type: 'coach-text', delta: event.delta })
            speakSentences(ctx.chunker.push(event.delta))
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
              },
            })
            break
          case 'hint':
            ctx.toolRan = true
            dispatch({ type: 'hint', text: event.text })
            break
          case 'session_complete':
            ctx.completeSeen = true
            dispatch({ type: 'session-complete' })
            break
          case 'done': {
            terminal = true
            speakSentences(ctx.chunker.flush())
            ctx.turnActive = false
            ctx.firstTurnDone = true
            ctx.retry = null
            dispatch({ type: 'turn-done' })
            const { start, firstText, firstSpeak } = ctx.timing
            postVoiceMetrics(sessionId, {
              ttftMs: firstText === null ? undefined : Math.round(firstText - start),
              ttfaMs: firstSpeak === null ? undefined : Math.round(firstSpeak - start),
              responseMs: Math.round(performance.now() - start),
            })
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
      failTurn({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }, utterance)
      return
    }
    if (stale()) return
    if (!terminal) failTurn({ code: 'VOICE_INTERRUPTED', message: '', retryable: true }, utterance)
  }

  function bargeIn(countInterrupt: boolean) {
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

  function submit(text: string, options: { countInterrupt: boolean }) {
    if (ctx.ended || !ctx.sessionId) return
    const clean = text.trim().slice(0, MAX_UTTERANCE_CHARS)
    if (!clean) return
    if (ctx.turnActive || ctx.speakingNow) bargeIn(options.countInterrupt)
    if (ctx.ended) return
    ctx.nudged = false
    ctx.retry = null
    dispatch({ type: 'student-said', text: clean })
    queueTurn(clean)
  }

  // ---- Public API ------------------------------------------------------------------------

  async function start(config: StartConfig): Promise<void> {
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
        language: config.language,
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
    ctx.speaker = createSessionSpeaker(config.language)

    const recognitionAvailable = getRecognitionConstructor() !== null
    ctx.inputMode = recognitionAvailable ? 'voice' : 'text'
    ctx.speechOn = ctx.speaker !== null
    dispatch({
      type: 'started',
      at: Date.now(),
      style: options.mode === 'sprint' ? 'oral_quiz' : config.style,
      inputMode: ctx.inputMode,
      speech: ctx.speaker ? 'on' : 'unsupported',
      micNotice: recognitionAvailable ? null : 'unsupported',
    })

    ctx.heartbeat = setInterval(() => {
      if (ctx.sessionId && !ctx.ended) void patchVoiceSession({ sessionId: ctx.sessionId, heartbeat: true })
    }, HEARTBEAT_MS)

    if (recognitionAvailable) void enableVoice()
    queueTurn('')
  }

  async function enableMicrophone(): Promise<void> {
    if (ctx.ended || !getRecognitionConstructor()) return
    await enableVoice()
  }

  return {
    meter,
    setOptions(next) {
      options = next
    },
    start,
    enableMicrophone,

    end() {
      finish('user')
    },

    reset() {
      dispatch({ type: 'reset' })
    },

    sendText(text) {
      submit(text, { countInterrupt: false })
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
        stopRecognition()
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
      ctx.speechOn = !ctx.speechOn
      if (!ctx.speechOn) ctx.speaker.cancel()
      dispatch({ type: 'speech', output: ctx.speechOn ? 'on' : 'off' })
    },

    hint() {
      submit('Can I have a hint?', { countInterrupt: false })
    },

    skip() {
      submit('Skip this question and ask me the next one.', { countInterrupt: false })
    },

    retry() {
      if (ctx.ended || !ctx.retry || ctx.turnActive) return
      const { utterance } = ctx.retry
      ctx.retry = null
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
