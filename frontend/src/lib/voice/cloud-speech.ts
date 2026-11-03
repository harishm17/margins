/**
 * Cloud speech recognition for voice practice (spec 19.12): AssemblyAI's streaming recognizer, reached straight from
 * the browser with a short-lived token this server mints. The API key never leaves the server, and the token can open
 * a recognition session only for a minute, and that session can last no longer than the student's voice time left today.
 *
 * Pure parts (the settings and the URL) are exported for tests; `mintCloudSpeechToken` is the one network call.
 */

export const CLOUD_SPEECH_PROVIDER = 'assemblyai'
const TOKEN_URL = 'https://token.assemblyai.com/v1/token'
const STREAM_URL = 'wss://streaming.assemblyai.com/v3/ws'

/** The model, unless ASSEMBLYAI_STREAMING_MODEL names another: the multilingual one with course terms included. */
export const DEFAULT_STREAMING_MODEL = 'universal-3-6-pro'

/** The languages voice practice offers (speech.ts) that the default model takes as `language_codes`. */
const MODEL_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'hi', 'zh', 'ja', 'ko'])

/** The audio the browser sends: 16 kHz mono PCM16 (what the capture worklet makes). */
export const CLOUD_SAMPLE_RATE = 16000

/**
 * Turn settings. The recognizer closes a segment quickly (a check after 160 ms of quiet, at most 800 ms); the session's
 * own end-of-turn wait (end-of-turn.ts) then decides whether the student has finished, as it does for browser speech.
 */
export const MIN_TURN_SILENCE_MS = 160
export const MAX_TURN_SILENCE_MS = 800
/** No audio for this long (a frozen tab) ends the session at AssemblyAI, so it does not run on unheard. */
export const INACTIVITY_TIMEOUT_S = 30

/** Course terms as the recognizer takes them: at most 100, each at most 50 characters and 6 words. */
export const MAX_KEYTERMS = 100
const MAX_KEYTERM_CHARS = 50
const MAX_KEYTERM_WORDS = 6

export function cloudSpeechConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ASSEMBLYAI_API_KEY === 'string' && env.ASSEMBLYAI_API_KEY.trim().length > 0
}

export function keytermsFor(terms: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim()
    if (term.length < 2 || term.length > MAX_KEYTERM_CHARS) continue
    if (term.split(' ').length > MAX_KEYTERM_WORDS) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= MAX_KEYTERMS) break
  }
  return out
}

/** The WebSocket address without the token (the browser adds it). */
export function cloudSpeechUrl(input: { language: string; terms: string[]; model?: string }): string {
  const params = new URLSearchParams({
    speech_model: input.model || DEFAULT_STREAMING_MODEL,
    sample_rate: String(CLOUD_SAMPLE_RATE),
    encoding: 'pcm_s16le',
    min_turn_silence: String(MIN_TURN_SILENCE_MS),
    max_turn_silence: String(MAX_TURN_SILENCE_MS),
    inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
  })
  const language = input.language.toLowerCase()
  if (MODEL_LANGUAGES.has(language)) params.set('language_codes', JSON.stringify([language]))
  const keyterms = keytermsFor(input.terms)
  if (keyterms.length > 0) params.set('keyterms_prompt', JSON.stringify(keyterms))
  return `${STREAM_URL}?${params.toString()}`
}

/** How long one recognition session may run: the voice time left today, at least a minute, at most AssemblyAI's 3 h. */
export function sessionCapSeconds(remainingSeconds: number): number {
  const seconds = Number.isFinite(remainingSeconds) ? Math.ceil(remainingSeconds) : 60
  return Math.min(10_800, Math.max(60, seconds))
}

export class CloudSpeechError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/** A token that can open recognition sessions for 60 s; each session lasts at most `maxSessionSeconds`. */
export async function mintCloudSpeechToken(input: { maxSessionSeconds: number; fetchImpl?: typeof fetch }): Promise<string> {
  const key = process.env.ASSEMBLYAI_API_KEY?.trim()
  if (!key) throw new CloudSpeechError('Cloud speech is not configured', 503)
  const response = await (input.fetchImpl ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product: 'streaming',
      expires_in_seconds: 60,
      max_session_duration_seconds: sessionCapSeconds(input.maxSessionSeconds),
    }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new CloudSpeechError(`Token request failed (${response.status})`, 502)
  const body = (await response.json().catch(() => null)) as { token?: unknown } | null
  if (!body || typeof body.token !== 'string' || !body.token) throw new CloudSpeechError('Token missing', 502)
  return body.token
}
