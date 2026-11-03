/**
 * On-device recognition with the course's key terms as phrases (spec 19.5, client half).
 *
 * Chrome 142+ and Edge 142+ can recognise speech on the device and bias it towards a list of
 * phrases. It is used only when everything is there: `processLocally`, `phrases`, the phrase class,
 * and `available()` reporting that the language pack is already installed. The app never starts a
 * language-pack download (no `install()` call anywhere). Where any piece is missing the browser's
 * normal recognizer runs, with no phrases (an unsupported `phrases` would make `start()` fail).
 */

export type OnDeviceEnv = {
  /** The recognizer constructor with its static `available`, as the browser gives it. */
  Recognition: unknown
  /** The `SpeechRecognitionPhrase` class. */
  Phrase: unknown
}

type AvailableFn = (options: { langs: string[]; processLocally: boolean }) => Promise<string>

/** Terms the session sends: at most 100 (the contract), and short enough to be a phrase. */
export const MAX_PHRASES = 100
const MAX_PHRASE_CHARS = 60
/** Between 0 and 10; a lift, not a lock. */
export const PHRASE_BOOST = 5

/**
 * A browser driven by a test tool. Headless Chromium has no speech service, and asking it
 * `SpeechRecognition.available()` crashes the page (seen in Chromium 156), so nothing is asked there.
 */
export function isAutomatedBrowser(input: { webdriver?: boolean; userAgent: string }): boolean {
  return input.webdriver === true || /HeadlessChrome/i.test(input.userAgent)
}

export function onDeviceEnvFromWindow(): OnDeviceEnv | null {
  if (typeof window === 'undefined') return null
  if (isAutomatedBrowser({ webdriver: navigator.webdriver, userAgent: navigator.userAgent })) return null
  const w = window as unknown as Record<string, unknown>
  return { Recognition: w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null, Phrase: w.SpeechRecognitionPhrase ?? null }
}

/** True when this browser can run on-device recognition with phrases, and the pack for `tag` is installed. */
export async function onDeviceReady(env: OnDeviceEnv | null, tag: string, timeoutMs = 1500): Promise<boolean> {
  if (!env || typeof env.Recognition !== 'function' || typeof env.Phrase !== 'function') return false
  const Recognition = env.Recognition as { available?: unknown; prototype?: object }
  if (typeof Recognition.available !== 'function') return false
  const prototype = Recognition.prototype
  if (!prototype || !('processLocally' in prototype) || !('phrases' in prototype)) return false
  try {
    const ask = (Recognition.available as AvailableFn).call(Recognition, { langs: [tag], processLocally: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const status = await Promise.race([ask, timeout])
    if (timer) clearTimeout(timer)
    return status === 'available'
  } catch {
    return false
  }
}

/** The terms to bias towards: trimmed, no duplicates (ignoring case), short, at most 100. */
export function cleanTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of terms) {
    if (typeof term !== 'string') continue
    const text = term.replace(/\s+/g, ' ').trim()
    if (text.length < 2 || text.length > MAX_PHRASE_CHARS) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_PHRASES) break
  }
  return out
}


/** Switch a recognizer to on-device mode with the phrases. Returns false (and leaves it as it was) if the browser refuses. */
export function enableOnDevice(recognition: object, env: OnDeviceEnv, terms: string[]): boolean {
  const Phrase = env.Phrase as new (phrase: string, boost: number) => unknown
  const target = recognition as { processLocally?: boolean; phrases?: unknown[] }
  try {
    target.processLocally = true
    const phrases = cleanTerms(terms).map((term) => new Phrase(term, PHRASE_BOOST))
    try {
      target.phrases = phrases
    } catch {
      // `phrases` is an ObservableArray: fill it in place if replacing the whole list is refused.
      for (const phrase of phrases) target.phrases?.push(phrase)
    }
    return true
  } catch {
    try {
      target.processLocally = false
    } catch {
      // ignore
    }
    return false
  }
}

// ---- What the lobby says about where the audio goes ------------------------------------------

export type SpeechDestination = 'device' | 'google' | 'apple' | 'browser'

/**
 * Where the audio goes when the student talks: nowhere (on-device), Google (Chrome), Apple (Safari,
 * and every browser on an iPhone or iPad, which all run WebKit), or the browser's own speech service.
 */
export function speechDestination(input: { userAgent: string; ios: boolean; onDevice: boolean }): SpeechDestination {
  if (input.onDevice) return 'device'
  const ua = input.userAgent
  if (input.ios) return 'apple'
  if (/Edg\/|EdgA\/|OPR\/|Opera|SamsungBrowser|Firefox|Vivaldi|Brave/i.test(ua)) return 'browser'
  if (/Chrome\/|Chromium\//i.test(ua)) return 'google'
  if (/Safari\//i.test(ua)) return 'apple'
  return 'browser'
}
