/**
 * Cloud speech recognition (spec 19.12): the page captures the microphone itself, sends 16 kHz PCM16 frames to a
 * streaming recognizer over a WebSocket (Deepgram or AssemblyAI, whichever the server's grant names), and turns its
 * messages into the same running result list the browser recognizer gives. So the rest of voice mode (the end-of-turn wait, echo and backchannel filters, barge-in,
 * Done) works unchanged: `CloudRecognition` is a `RecognitionLike`.
 *
 * Owning the audio adds one thing the browser recognizer cannot give: the level of each frame. A rise in level after
 * a finished segment means the student has started again before the recognizer's words arrive (about a second later),
 * so the wait is held open instead of ending the turn under them.
 *
 * Pure parts (the result list, the silence after the last word, the voice-activity tracker) are exported for tests.
 */
import type { RecognitionLike, RecognitionResultEvent } from './speech'

// ---- Pure: messages to results -------------------------------------------------------------

export type CloudWord = { text?: string; start?: number; end?: number; word_is_final?: boolean }
export type CloudTurn = { type: 'Turn'; turn_order: number; end_of_turn: boolean; transcript: string; words?: CloudWord[] }

export type TurnState = {
  /** One entry per turn of this stream, by `turn_order`. */
  turns: { transcript: string; isFinal: boolean }[]
  /** The end (ms of audio) of the last word heard in a partial of the current turn. */
  lastWordEndMs: number | null
  /** Speech is heard (by level) after the last finished turn and no words have come yet. */
  pendingVoice: boolean
}

export const emptyTurnState = (): TurnState => ({ turns: [], lastWordEndMs: null, pendingVoice: false })

/**
 * Apply one Turn message. The recognizer stretches the end of the last word in the final message to the moment it
 * closed the segment, so the end of the speech is taken from the partials (the final's words only when there were none).
 */
export function applyTurn(state: TurnState, message: CloudTurn): TurnState {
  const turns = state.turns.slice()
  const index = Math.max(0, Math.floor(message.turn_order))
  while (turns.length < index) turns.push({ transcript: '', isFinal: true })
  turns[index] = { transcript: (message.transcript ?? '').trim(), isFinal: message.end_of_turn === true }
  const words = message.words ?? []
  const lastEnd = words.length > 0 ? words[words.length - 1]?.end : undefined
  let lastWordEndMs = state.lastWordEndMs
  if (!message.end_of_turn && typeof lastEnd === 'number') lastWordEndMs = lastEnd
  if (message.end_of_turn && lastWordEndMs === null && typeof lastEnd === 'number') lastWordEndMs = lastEnd
  return { turns, lastWordEndMs, pendingVoice: false }
}

/** Deepgram's `Results` message (the parts read here). Word times are in seconds from the start of the stream. */
export type DeepgramResults = {
  type: 'Results'
  is_final?: boolean
  speech_final?: boolean
  channel?: { alternatives?: { transcript?: string; words?: { end?: number }[] }[] }
}

/**
 * Apply one Deepgram `Results` message. Deepgram finalises the stream in segments (`is_final`); between them it sends
 * interim guesses for the segment in progress. So the list is the final segments, then at most one interim one, and an
 * interim is always replaced at its own position (by the next guess or by its final), never moved. A segment that turns
 * out empty stays as an empty final, so later positions do not shift. `speech_final` closes the segment: the end of turn
 * the session's wait then runs from.
 */
export function applyDeepgram(state: TurnState, message: DeepgramResults): { state: TurnState; segmentEnd: boolean } {
  const alternative = message.channel?.alternatives?.[0]
  const transcript = (alternative?.transcript ?? '').trim()
  const turns = state.turns.slice()
  const last = turns[turns.length - 1]
  const hasInterim = last !== undefined && !last.isFinal
  const put = (entry: { transcript: string; isFinal: boolean }) => {
    if (hasInterim) turns[turns.length - 1] = entry
    else turns.push(entry)
  }
  if (message.is_final) {
    if (transcript || hasInterim) put({ transcript, isFinal: true })
  } else if (transcript) {
    put({ transcript, isFinal: false })
  }
  const words = alternative?.words ?? []
  const lastEnd = words.length > 0 ? words[words.length - 1]?.end : undefined
  const lastWordEndMs = typeof lastEnd === 'number' && Number.isFinite(lastEnd) ? Math.round(lastEnd * 1000) : state.lastWordEndMs
  const segmentEnd = message.speech_final === true && lastWordEndMs !== null
  return { state: { turns, lastWordEndMs, pendingVoice: transcript ? false : state.pendingVoice }, segmentEnd }
}

/**
 * The result list for the collector: one result per turn, so its positions stay the recognizer's turn numbers (the
 * collector counts what it has used by position). While new speech is heard but not yet worded, the last segment is
 * reported as not final, which holds the wait open without adding an entry the next turn would then have to replace.
 */
export function resultsOf(state: TurnState): { transcript: string; isFinal: boolean }[] {
  const results = state.turns.map((turn) => ({ ...turn }))
  const last = results[results.length - 1]
  if (state.pendingVoice && last?.isFinal) results[results.length - 1] = { ...last, isFinal: false }
  return results
}

/** How long the student has been quiet when a segment closes: audio sent so far minus the end of the last word. */
export function silenceAfterLastWordMs(audioSentMs: number, lastWordEndMs: number | null): number {
  if (lastWordEndMs === null || !Number.isFinite(lastWordEndMs)) return 0
  return Math.max(0, Math.round(audioSentMs - lastWordEndMs))
}

/** As a browser result event, so the controller reads it the same way. */
export function toResultEvent(results: { transcript: string; isFinal: boolean }[]): RecognitionResultEvent {
  const list = results.map((result) => ({ 0: { transcript: result.transcript, confidence: 1 }, length: 1, isFinal: result.isFinal }))
  return { resultIndex: 0, results: list }
}

// ---- Pure: voice activity from frame levels -------------------------------------------------

/**
 * Speech by level: two frames in a row (200 ms) clearly above the noise floor. The floor follows quiet frames, and
 * loud ones very slowly too, so a fan or a hum that is always there is learnt in a few seconds and not taken for speech.
 */
export type ActivityTracker = { push: (rms: number) => boolean; readonly floor: number }

export function createActivityTracker(options: { minRms?: number; ratio?: number; frames?: number } = {}): ActivityTracker {
  const minRms = options.minRms ?? 0.02
  const ratio = options.ratio ?? 3
  const needed = options.frames ?? 2
  let floor = 0.005
  let loud = 0
  return {
    push(rms) {
      const threshold = Math.max(minRms, floor * ratio)
      if (rms > threshold) {
        loud += 1
        floor = floor * 0.99 + rms * 0.01
      } else {
        loud = 0
        floor = floor * 0.95 + rms * 0.05
      }
      return loud >= needed
    },
    get floor() {
      return floor
    },
  }
}

export function rmsOf(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i] / 0x8000
    sum += value * value
  }
  return Math.sqrt(sum / frame.length)
}

// ---- Microphone capture ---------------------------------------------------------------------

export type MicCapture = {
  /** Opens the microphone (throws the getUserMedia error on refusal) and starts making frames. */
  start: () => Promise<void>
  stop: () => void
  /** Every 100 ms frame while open. Returns the unsubscribe. */
  onFrame: (listener: (frame: Int16Array) => void) => () => void
  /** The microphone was lost and could not be opened again (see `createMicCapture`). Returns the unsubscribe. */
  onFailed: (listener: () => void) => () => void
  readonly active: boolean
}

/**
 * How often a lost microphone may be opened again: at most `max` times in `windowMs`. Past that it is not coming back
 * (unplugged, taken by another app), and voice mode should stop waiting for it.
 */
export function createRecoveryBudget(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
  const max = options.max ?? 3
  const windowMs = options.windowMs ?? 30_000
  const now = options.now ?? Date.now
  let times: number[] = []
  return {
    allow(): boolean {
      const at = now()
      times = times.filter((time) => at - time < windowMs)
      if (times.length >= max) return false
      times.push(at)
      return true
    },
  }
}

/** No frame for this long while open means the capture has stalled (the worklet makes one every 100 ms). */
export const CAPTURE_STALL_MS = 2000

export const FRAME_MS = 100
const WORKLET_URL = '/voice/pcm16-worklet.js'

/** True when this browser can capture audio for cloud recognition. */
export function canCaptureAudio(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  return !!navigator.mediaDevices?.getUserMedia && !!Ctor && typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined'
}

/**
 * The page's own microphone capture. A microphone can go away mid-session: a headset connects or is unplugged, the
 * system switches devices, iOS hands the audio to a call. The browser's recognizer copes with that by itself, so this
 * must too. When the track ends, or no frame has come for `CAPTURE_STALL_MS`, the microphone is opened again with the
 * same listeners, quickly enough that the recognizer's stream stays open (Deepgram closes after 10 s without audio).
 * A suspended audio context (iOS after an interruption) is resumed. When reopening keeps failing, `onFailed` fires and
 * the capture stays closed.
 */
export function createMicCapture(): MicCapture {
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let starting: Promise<void> | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  let lastFrameAt = 0
  let recovering = false
  let budget = createRecoveryBudget()
  const listeners = new Set<(frame: Int16Array) => void>()
  const failedListeners = new Set<() => void>()

  /** Let go of the current microphone and audio graph; the listeners stay. */
  const release = () => {
    if (node) {
      node.port.onmessage = null
      node.disconnect()
    }
    node = null
    stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    stream = null
    if (context) {
      context.onstatechange = null
      void context.close().catch(() => undefined)
    }
    context = null
  }

  const stop = () => {
    starting = null
    recovering = false
    if (watchdog) clearInterval(watchdog)
    watchdog = null
    release()
  }

  const fail = () => {
    stop()
    for (const listener of [...failedListeners]) listener()
  }

  const recover = async () => {
    if (recovering || !stream) return
    if (!budget.allow()) return fail()
    recovering = true
    release()
    try {
      await open()
    } catch {
      recovering = false
      return fail()
    }
    recovering = false
  }

  const open = async () => {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    const audio = new Ctor()
    try {
      await audio.audioWorklet.addModule(WORKLET_URL)
      if (audio.state === 'suspended') await audio.resume().catch(() => undefined)
      const source = audio.createMediaStreamSource(media)
      const worklet = new AudioWorkletNode(audio, 'margins-pcm16', { numberOfInputs: 1, numberOfOutputs: 0 })
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        lastFrameAt = Date.now()
        const frame = new Int16Array(event.data)
        for (const listener of listeners) listener(frame)
      }
      source.connect(worklet)
      for (const track of media.getAudioTracks()) track.onended = () => void recover()
      // iOS suspends the context for a call or another app's audio; it does not resume by itself.
      audio.onstatechange = () => {
        if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
      }
      stream = media
      context = audio
      node = worklet
      lastFrameAt = Date.now()
      if (!watchdog) {
        watchdog = setInterval(() => {
          if (stream && !recovering && Date.now() - lastFrameAt > CAPTURE_STALL_MS) void recover()
        }, 1000)
      }
    } catch (error) {
      media.getTracks().forEach((track) => track.stop())
      void audio.close().catch(() => undefined)
      throw error
    }
  }

  return {
    start() {
      if (stream) return Promise.resolve()
      if (!starting) {
        budget = createRecoveryBudget()
        starting = open().catch((error) => {
          starting = null
          throw error
        })
      }
      return starting
    },
    stop,
    onFrame(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onFailed(listener) {
      failedListeners.add(listener)
      return () => failedListeners.delete(listener)
    },
    get active() {
      return stream !== null
    },
  }
}

// ---- The recognizer -------------------------------------------------------------------------

export type CloudProvider = 'deepgram' | 'assemblyai'
export type CloudGrant = { provider: CloudProvider; url: string; token: string }

/** How each provider is spoken to: how the token is passed, when the stream is open, and how it is closed. */
const PROTOCOL: Record<
  CloudProvider,
  { connect: (Socket: typeof WebSocket, grant: CloudGrant) => WebSocket; openOn: 'open' | 'Begin'; flush: string[]; end: string }
> = {
  // The token as the `bearer` subprotocol: the one header a browser can set on a WebSocket.
  deepgram: {
    connect: (Socket, grant) => new Socket(grant.url, ['bearer', grant.token]),
    openOn: 'open',
    flush: [JSON.stringify({ type: 'Finalize' }), JSON.stringify({ type: 'CloseStream' })],
    end: JSON.stringify({ type: 'CloseStream' }),
  },
  assemblyai: {
    connect: (Socket, grant) => new Socket(`${grant.url}&token=${encodeURIComponent(grant.token)}`),
    openOn: 'Begin',
    flush: [JSON.stringify({ type: 'ForceEndpoint' }), JSON.stringify({ type: 'Terminate' })],
    end: JSON.stringify({ type: 'Terminate' }),
  },
}

export type CloudRecognitionDeps = {
  capture: MicCapture
  /** A fresh grant for each stream (a token only opens one stream, for a short time). */
  grant: () => Promise<CloudGrant>
  /** This provider refused the stream (spent credit, an outage): the next grant should leave it out. */
  onRefused?: (provider: CloudProvider) => void
  /** A segment closed after this much quiet (for the end-of-turn wait). */
  onSegmentEnd?: (silenceMs: number) => void
  /** The level of each frame, 0..1 (for the orb). */
  onLevel?: (level: number) => void
  WebSocketImpl?: typeof WebSocket
  /** How long a stream may take to open (default CONNECT_TIMEOUT_MS). */
  connectTimeoutMs?: number
}

/** How long new speech may go unworded before the hold is dropped (noise, a cough). */
const VOICE_HOLD_MS = 2000

/**
 * A stream that has not opened by now is treated as refused. A socket to a host that never answers stays "connecting"
 * for as long as the browser allows (a minute or more), and the student would talk into nothing all that time.
 */
const CONNECT_TIMEOUT_MS = 6000

/** The browser-recognizer error codes the controller knows, plus `cloud-unavailable`: use the browser's recognizer. */
export type CloudErrorCode = 'cloud-unavailable' | 'network' | 'not-allowed' | 'audio-capture'

/** A recognizer class for the controller, bound to this session's capture and grants. */
export function cloudRecognitionClass(deps: CloudRecognitionDeps): new () => RecognitionLike {
  return class CloudRecognition implements RecognitionLike {
    continuous = true
    interimResults = true
    lang = 'en-US'
    maxAlternatives = 1
    onresult: RecognitionLike['onresult'] = null
    onerror: RecognitionLike['onerror'] = null
    onend: RecognitionLike['onend'] = null
    onstart: RecognitionLike['onstart'] = null

    private socket: WebSocket | null = null
    private provider: CloudProvider | null = null
    private unsubscribe: (() => void) | null = null
    private state = emptyTurnState()
    private sentMs = 0
    private opened = false
    private ended = false
    private activity = createActivityTracker()
    private holdTimer: ReturnType<typeof setTimeout> | null = null
    private connectTimer: ReturnType<typeof setTimeout> | null = null
    /** The finished segment the last hold was for: one hold per segment, so steady noise cannot keep the turn open. */
    private heldFor = -1
    /** A graceful stop is waiting for the recognizer's last words. */
    private closing = false

    start(): void {
      void this.run()
    }

    stop(): void {
      this.close(true)
    }

    abort(): void {
      this.close(false)
    }

    private emit() {
      this.onresult?.(toResultEvent(resultsOf(this.state)))
    }

    private fail(code: CloudErrorCode) {
      if (this.ended) return
      this.onerror?.({ error: code })
      this.finish()
    }

    private finish() {
      if (this.ended) return
      this.ended = true
      this.unsubscribe?.()
      this.unsubscribe = null
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.holdTimer = null
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      const socket = this.socket
      this.socket = null
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try {
          if (socket.readyState === 1 && this.provider) socket.send(PROTOCOL[this.provider].end)
          socket.close(1000)
        } catch {
          // already closed
        }
      }
      this.onend?.()
    }

    /** `graceful`: ask the recognizer for what it still holds and wait a moment for it; otherwise end at once. */
    private close(graceful: boolean) {
      if (this.ended) return
      const socket = this.socket
      if (!graceful || !socket || socket.readyState !== 1) {
        this.finish()
        return
      }
      this.unsubscribe?.()
      this.unsubscribe = null
      this.closing = true
      try {
        for (const message of PROTOCOL[this.provider ?? 'assemblyai'].flush) socket.send(message)
      } catch {
        this.finish()
        return
      }
      setTimeout(() => this.finish(), 1500)
    }

    private onFrame(frame: Int16Array) {
      const socket = this.socket
      if (!socket || socket.readyState !== 1 || this.ended) return
      try {
        socket.send(frame.buffer as ArrayBuffer)
      } catch {
        return
      }
      this.sentMs += FRAME_MS
      const rms = rmsOf(frame)
      deps.onLevel?.(Math.min(1, rms * 6))
      const voiced = this.activity.push(rms)
      const last = this.state.turns[this.state.turns.length - 1]
      const segment = this.state.turns.length - 1
      if (voiced && !this.state.pendingVoice && last?.isFinal && this.heldFor !== segment) {
        this.heldFor = segment
        // The student started again after a finished segment: hold the wait open until their words arrive.
        this.state = { ...this.state, pendingVoice: true }
        this.emit()
        if (this.holdTimer) clearTimeout(this.holdTimer)
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          if (this.ended || !this.state.pendingVoice) return
          this.state = { ...this.state, pendingVoice: false }
          this.emit()
        }, VOICE_HOLD_MS)
      }
    }

    private begin() {
      if (this.opened || this.ended) return
      this.opened = true
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      this.unsubscribe = deps.capture.onFrame((frame) => this.onFrame(frame))
      this.onstart?.()
    }

    private async run() {
      let grant: CloudGrant
      try {
        await deps.capture.start()
      } catch (error) {
        const name = (error as { name?: string } | null)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') return this.fail('not-allowed')
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return this.fail('audio-capture')
        return this.fail('cloud-unavailable')
      }
      if (this.ended) return
      try {
        grant = await deps.grant()
      } catch {
        return this.fail('cloud-unavailable')
      }
      if (this.ended) return
      const protocol = PROTOCOL[grant.provider] ?? PROTOCOL.assemblyai
      this.provider = grant.provider
      let socket: WebSocket
      try {
        socket = protocol.connect(deps.WebSocketImpl ?? WebSocket, grant)
      } catch {
        deps.onRefused?.(grant.provider)
        return this.fail('cloud-unavailable')
      }
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      this.connectTimer = setTimeout(() => {
        if (this.ended || this.opened) return
        deps.onRefused?.(grant.provider)
        this.fail('cloud-unavailable')
      }, deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        if (protocol.openOn === 'open') this.begin()
      }
      socket.onmessage = (event) => this.onMessage(event.data)
      socket.onerror = () => {
        // The close event follows with the reason.
      }
      socket.onclose = (event) => {
        if (this.ended) return
        // Refused (1008: the token, the account or its credit) or never opened (the service cannot be reached): this
        // provider is out for the session and the next one, or the browser's own recognizer, takes over. A drop
        // mid-stream is a network error: the controller reconnects.
        if (event.code === 1008 || !this.opened) {
          deps.onRefused?.(grant.provider)
          return this.fail('cloud-unavailable')
        }
        if (event.code === 1000 || event.code === 3008) return this.finish()
        return this.fail('network')
      }
    }

    private segmentClosed() {
      deps.onSegmentEnd?.(silenceAfterLastWordMs(this.sentMs, this.state.lastWordEndMs))
      this.state = { ...this.state, lastWordEndMs: null }
    }

    private wordsArrived() {
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.holdTimer = null
    }

    private onMessage(data: unknown) {
      if (this.ended || typeof data !== 'string') return
      let message: { type?: string } & Record<string, unknown>
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      // AssemblyAI
      if (message.type === 'Begin') return this.begin()
      if (message.type === 'Turn') {
        const turn = message as unknown as CloudTurn
        this.state = applyTurn(this.state, turn)
        this.wordsArrived()
        if (turn.end_of_turn) this.segmentClosed()
        this.emit()
        return
      }
      if (message.type === 'Termination') return this.finish()
      // Deepgram
      if (message.type === 'Results') {
        const applied = applyDeepgram(this.state, message as unknown as DeepgramResults)
        this.state = applied.state
        // Words ended any hold (applyDeepgram clears it when the message has a transcript).
        if (!this.state.pendingVoice) this.wordsArrived()
        if (applied.segmentEnd) this.segmentClosed()
        this.emit()
        return
      }
      // Sent after CloseStream, once everything is transcribed.
      if (message.type === 'Metadata' && this.socket && this.closing) this.finish()
    }
  }
}
