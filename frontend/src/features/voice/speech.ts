/**
 * Browser speech: language list, voice choice, the recognizer constructor and a sentence queue
 * for speechSynthesis. Everything that touches `window` is inside a function, so the pure
 * parts (languageTag, scoreVoice, pickVoice) can be tested in node.
 */

// ---- Languages ---------------------------------------------------------------------------

export type VoiceLanguage = { code: string; label: string; tag: string }

/** `code` goes to the server (the coach speaks only this language); `tag` goes to the browser. */
export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { code: 'en', label: 'English', tag: 'en-US' },
  { code: 'es', label: 'Spanish', tag: 'es-ES' },
  { code: 'fr', label: 'French', tag: 'fr-FR' },
  { code: 'de', label: 'German', tag: 'de-DE' },
  { code: 'it', label: 'Italian', tag: 'it-IT' },
  { code: 'pt', label: 'Portuguese', tag: 'pt-BR' },
  { code: 'hi', label: 'Hindi', tag: 'hi-IN' },
  { code: 'zh', label: 'Chinese', tag: 'zh-CN' },
  { code: 'ja', label: 'Japanese', tag: 'ja-JP' },
  { code: 'ko', label: 'Korean', tag: 'ko-KR' },
]

export function languageTag(code: string): string {
  return VOICE_LANGUAGES.find((language) => language.code === code)?.tag ?? code
}

/** The browser's own language when the list has it, else English. */
export function defaultLanguageCode(navigatorLanguage: string | undefined): string {
  const base = (navigatorLanguage ?? 'en').toLowerCase().split('-')[0]
  return VOICE_LANGUAGES.some((language) => language.code === base) ? base : 'en'
}

// ---- Voices ------------------------------------------------------------------------------

export type VoiceInfo = {
  name: string
  lang: string
  localService?: boolean
  default?: boolean
}

const NATURAL = /natural|neural|premium|enhanced|studio|wavenet|online/i
const GOOGLE = /^google\b/i
const ROBOTIC = /espeak|compact|festival|flite|pico/i
// macOS novelty voices that no one wants reading study questions.
const NOVELTY =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph)\b/i

const normalizeLang = (lang: string) => lang.replace('_', '-').toLowerCase()

/** Higher is better; negative means do not use. */
export function scoreVoice(voice: VoiceInfo, tag: string): number {
  const wanted = normalizeLang(tag)
  const lang = normalizeLang(voice.lang)
  const wantedBase = wanted.split('-')[0]
  if (lang.split('-')[0] !== wantedBase) return -1

  let score = 10
  if (lang === wanted) score += 20
  if (NATURAL.test(voice.name)) score += 30
  else if (GOOGLE.test(voice.name)) score += 22
  if (voice.localService === false) score += 2
  if (voice.default) score += 3
  if (ROBOTIC.test(voice.name)) score -= 15
  if (NOVELTY.test(voice.name)) score -= 25
  return score
}

/** The most natural installed voice for the language, or null (the browser then picks one). */
export function pickVoice<T extends VoiceInfo>(voices: T[], tag: string): T | null {
  let best: T | null = null
  let bestScore = 0
  for (const voice of voices) {
    const score = scoreVoice(voice, tag)
    if (score > bestScore) {
      best = voice
      bestScore = score
    }
  }
  return best
}

// ---- Recognition -------------------------------------------------------------------------

export type RecognitionAlternative = { transcript: string; confidence: number }
export type RecognitionResult = { readonly length: number; isFinal: boolean; [index: number]: RecognitionAlternative }
export type RecognitionResultList = { readonly length: number; [index: number]: RecognitionResult }
export type RecognitionResultEvent = { resultIndex: number; results: RecognitionResultList }
export type RecognitionErrorEvent = { error: string; message?: string }

export type RecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

export type RecognitionConstructor = new () => RecognitionLike

type SpeechWindow = {
  SpeechRecognition?: RecognitionConstructor
  webkitSpeechRecognition?: RecognitionConstructor
  speechSynthesis?: SpeechSynthesis
}

export function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as SpeechWindow
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function hasSpeechSynthesis(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as SpeechWindow
  return !!w.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** iPhone, iPad and iPod, including an iPad that says it is a Mac. Every browser on them is WebKit. */
export function isIosPlatform(input: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  if (/iPhone|iPad|iPod/i.test(input.userAgent)) return true
  return input.platform === 'MacIntel' && (input.maxTouchPoints ?? 0) > 1
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIosPlatform({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })
}

/** The words of every result so far, in order (what the collector wants). */
export function resultsFromEvent(event: RecognitionResultEvent): { transcript: string; isFinal: boolean }[] {
  const out: { transcript: string; isFinal: boolean }[] = []
  for (let i = 0; i < event.results.length; i += 1) {
    const result = event.results[i]
    out.push({ transcript: result[0]?.transcript ?? '', isFinal: result.isFinal })
  }
  return out
}

/**
 * The words that became final since the last look, and how many final results have now been taken. Dictation adds only these
 * to what is already in the box, so what the student typed while talking is kept instead of being written over.
 */
export function newFinalWords(parts: { transcript: string; isFinal: boolean }[], taken: number): { words: string[]; taken: number } {
  const finals = parts.filter((part) => part.isFinal).map((part) => part.transcript.trim())
  return { words: finals.slice(taken).filter(Boolean), taken: finals.length }
}

// ---- Speaking ----------------------------------------------------------------------------

/**
 * One sentence to say. `speech` is what the synthesizer gets (see speakable()); `display` is the
 * sentence as the student reads it. Only sentences with a `display` are part of the reply: they are
 * counted as heard when the student interrupts. A line without one (a filler, a sample) is not.
 */
export type SpeakItem = { speech: string; display?: string }

export type SpeakerEvent =
  | { type: 'start'; item: SpeakItem }
  | { type: 'boundary'; item: SpeakItem; charIndex: number }
  /** The sentence played to its end (or the watchdog decided it had). */
  | { type: 'end'; item: SpeakItem }
  /** The browser could not say it. */
  | { type: 'error'; item: SpeakItem }

export type Speaker = {
  /** Queue one sentence. */
  enqueue: (sentence: string | SpeakItem) => void
  /** Stop now and forget the queue. */
  cancel: () => void
  /** Resolves when nothing is playing or queued (immediately when idle). */
  whenIdle: () => Promise<void>
  readonly busy: boolean
  /** False once the browser proved it cannot speak (no voices, nothing ever started). */
  readonly working: boolean
}

export type SpeakerOptions = {
  lang: string
  /** The speaking rate, read for every sentence so a change in the settings applies at once. */
  rate?: number | (() => number)
  /** Picks the voice for a sentence (the chosen one, else the best); default is the best for the language. */
  chooseVoice?: (voices: SpeechSynthesisVoice[], lang: string) => SpeechSynthesisVoice | null
  onSpeakingChange: (speaking: boolean) => void
  /** A sentence started playing (for timing metrics). */
  onStart?: (item: SpeakItem) => void
  /** What is being said, sentence by sentence, for the record of what the student heard. */
  onEvent?: (event: SpeakerEvent) => void
  /** Nothing ever started: the browser has no usable voice. */
  onUnavailable?: () => void
}

const START_TIMEOUT_MS = 3000

/** Scripts written without spaces between words (Chinese, Japanese, Thai, Lao, Khmer, Burmese): length is counted in characters. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu

/**
 * How long a sentence may take to say before the queue stops waiting for its end event (some browsers never send one).
 * A sentence in a script without spaces is one "word" to a split on spaces: it was given four seconds whatever its
 * length, and the next sentence started over it. Each of its characters counts as half a word.
 */
export function speechTimeLimitMs(text: string, rate: number): number {
  const unspaced = text.match(UNSPACED_SCRIPT)?.length ?? 0
  const spaced = text.replace(UNSPACED_SCRIPT, ' ').split(/\s+/).filter(Boolean).length
  const words = spaced + unspaced / 2
  return Math.max(4000, (words * 700 + 2000) / rate)
}

/**
 * Speaks queued sentences one after another. Chrome and Safari are known to drop `end` events
 * (a cancelled tab, no voices installed), so every sentence has a watchdog: a sentence that
 * never starts, or runs far longer than its length allows, is treated as finished.
 */
export function createSpeaker(options: SpeakerOptions): Speaker {
  const synth = (window as unknown as SpeechWindow).speechSynthesis
  let queue: SpeakItem[] = []
  let generation = 0
  let current: { timers: ReturnType<typeof setTimeout>[]; settle: () => void } | null = null
  let broken = false
  let waiters: Array<() => void> = []

  const busy = () => current !== null || queue.length > 0

  const notifyIdle = () => {
    if (busy()) return
    options.onSpeakingChange(false)
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  const pump = () => {
    if (current || broken || !synth) return
    const item = queue.shift()
    if (item === undefined) {
      notifyIdle()
      return
    }
    const text = item.speech
    const myGeneration = generation
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = options.lang
    const rate = typeof options.rate === 'function' ? options.rate() : (options.rate ?? 1)
    utterance.rate = rate
    const voice = (options.chooseVoice ?? pickVoice)(synth.getVoices(), options.lang)
    if (voice) utterance.voice = voice

    const timers: ReturnType<typeof setTimeout>[] = []
    let settled = false
    let started = false
    const settle = (failed = false) => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      if (generation !== myGeneration) return
      if (started || !failed) options.onEvent?.({ type: failed ? 'error' : 'end', item })
      current = null
      pump()
    }
    current = { timers, settle }

    timers.push(
      setTimeout(() => {
        // Nothing started: this browser cannot speak. Stop trying so the session is not slowed down.
        if (generation !== myGeneration) return
        broken = true
        queue = []
        try {
          synth.cancel()
        } catch {
          // ignore
        }
        settle(true)
        notifyIdle()
        options.onUnavailable?.()
      }, START_TIMEOUT_MS)
    )

    utterance.onstart = () => {
      if (generation !== myGeneration) return
      started = true
      timers.forEach(clearTimeout)
      timers.length = 0
      timers.push(setTimeout(() => settle(), speechTimeLimitMs(text, rate)))
      options.onEvent?.({ type: 'start', item })
      options.onStart?.(item)
    }
    // Word boundaries come only from some voices (not Google's network ones): when they do, they say how far the sentence got.
    utterance.onboundary = (event) => {
      if (generation !== myGeneration || event.name === 'sentence') return
      options.onEvent?.({ type: 'boundary', item, charIndex: event.charIndex })
    }
    utterance.onend = () => settle()
    utterance.onerror = () => settle(true)

    try {
      synth.speak(utterance)
    } catch {
      settle(true)
    }
  }

  return {
    enqueue(sentence) {
      const item: SpeakItem = typeof sentence === 'string' ? { speech: sentence.trim() } : { ...sentence, speech: sentence.speech.trim() }
      if (!item.speech || !synth || broken) return
      const wasBusy = busy()
      queue.push(item)
      if (!wasBusy) options.onSpeakingChange(true)
      pump()
    },
    cancel() {
      generation += 1
      queue = []
      if (current) {
        current.timers.forEach(clearTimeout)
        current = null
      }
      try {
        synth?.cancel()
      } catch {
        // ignore
      }
      notifyIdle()
    },
    whenIdle() {
      if (!busy()) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    get busy() {
      return busy()
    },
    get working() {
      return !broken
    },
  }
}
