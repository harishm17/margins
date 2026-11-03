/**
 * The voice settings kept on the device (spec 19.7): whether replies are spoken, the speaking rate,
 * and the voice chosen for each language. Pure parsing and picking here; the store below keeps one
 * copy in memory, writes it to localStorage and tells subscribers (the controller and the settings UI).
 */
import { pickVoice, scoreVoice, type VoiceInfo } from './speech'

export const RATE_MIN = 0.8
export const RATE_MAX = 1.4
export const RATE_STEP = 0.1
export const PREFS_KEY = 'margins.voice.prefs.v1'

export type VoicePrefs = {
  /** "Speak replies": off means no speech output at all; the transcript is the output. */
  speak: boolean
  /** 0.8 to 1.4, 1 is the voice's normal pace. */
  rate: number
  /** The chosen voice for a language tag ("en-US"), by `voiceKey`. Missing means the best one is picked. */
  voices: Record<string, string>
  /**
   * How speech becomes text when the server offers cloud recognition (spec 19.12): 'cloud' sends the audio to the
   * speech service Margins uses; 'browser' keeps to the browser's own recognizer. Ignored when cloud is not offered.
   */
  recognition: 'cloud' | 'browser'
}

export const DEFAULT_PREFS: VoicePrefs = { speak: true, rate: 1, voices: {}, recognition: 'cloud' }

export function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, value))
  return Math.round(clamped * 100) / 100
}

/** A voice's identity: two voices can share a name across languages. */
export const voiceKey = (voice: Pick<VoiceInfo, 'name' | 'lang'>) => `${voice.name}|${voice.lang}`

export function parsePrefs(raw: string | null | undefined): VoicePrefs {
  if (!raw) return DEFAULT_PREFS
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PREFS
  const record = value as Record<string, unknown>
  const voices: Record<string, string> = {}
  if (typeof record.voices === 'object' && record.voices !== null && !Array.isArray(record.voices)) {
    for (const [tag, key] of Object.entries(record.voices as Record<string, unknown>)) {
      if (typeof key === 'string' && key && key.length < 300) voices[tag] = key
    }
  }
  return {
    speak: record.speak === false ? false : true,
    rate: typeof record.rate === 'number' ? clampRate(record.rate) : 1,
    voices,
    recognition: record.recognition === 'browser' ? 'browser' : 'cloud',
  }
}

/** The voice to speak with: the one the student chose if it is still installed, else the best for the language. */
export function resolveVoice<T extends VoiceInfo>(voices: T[], tag: string, chosenKey: string | null | undefined): T | null {
  if (chosenKey) {
    const chosen = voices.find((voice) => voiceKey(voice) === chosenKey)
    if (chosen && scoreVoice(chosen, tag) >= 0) return chosen
  }
  return pickVoice(voices, tag)
}

/** Voices that speak the language, best first: what the chooser lists. */
export function voicesForLanguage<T extends VoiceInfo>(voices: T[], tag: string): T[] {
  return voices
    .map((voice, index) => ({ voice, index, score: scoreVoice(voice, tag) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.voice)
}

// ---- Store -------------------------------------------------------------------------------

let current: VoicePrefs | null = null
const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null // blocked by the browser's privacy settings
  }
}

/** The settings. On the server, and where storage is blocked, the defaults. */
export function getVoicePrefs(): VoicePrefs {
  if (current) return current
  const store = storage()
  if (!store) return DEFAULT_PREFS
  let raw: string | null = null
  try {
    raw = store.getItem(PREFS_KEY)
  } catch {
    // ignore
  }
  current = parsePrefs(raw)
  return current
}

export function setVoicePrefs(patch: Partial<Omit<VoicePrefs, 'voices'>> & { voice?: { tag: string; key: string | null } }): void {
  const before = getVoicePrefs()
  const voices = { ...before.voices }
  if (patch.voice) {
    if (patch.voice.key) voices[patch.voice.tag] = patch.voice.key
    else delete voices[patch.voice.tag]
  }
  current = {
    speak: patch.speak ?? before.speak,
    rate: patch.rate === undefined ? before.rate : clampRate(patch.rate),
    voices,
    recognition: patch.recognition ?? before.recognition,
  }
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(current))
  } catch {
    // The setting still holds for this visit.
  }
  listeners.forEach((listener) => listener())
}

export function subscribeVoicePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** For tests: forget the in-memory copy. */
export function resetVoicePrefsForTest(): void {
  current = null
}
