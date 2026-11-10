/**
 * Cloud speech recognition for voice practice (spec 19.12): a streaming recognizer reached straight from the browser
 * with a short-lived token this server mints. The API keys never leave the server.
 *
 * Two providers are built in: Deepgram (Nova-3) and AssemblyAI (Universal-3.6 Pro). By default only Deepgram is used:
 * every stream opts out of its model training (`mip_opt_out`), while AssemblyAI trains on audio unless a paid account
 * opts out in its dashboard, and the privacy page promises a student's material is not used for training. Set
 * CLOUD_SPEECH_PROVIDERS ("deepgram,assemblyai") to add AssemblyAI or change the order. Only providers with a key
 * are offered. A provider whose
 * token cannot be minted is skipped, and the browser can ask again leaving out one that refused its stream (spent
 * credit, an outage), so a session moves to the next provider before it falls back to the browser's own recognizer.
 *
 * Pure parts (the order, the URLs, the term lists) are exported for tests; `mintCloudSpeechGrant` makes the network calls.
 */

import { logServerError } from '@/lib/ops/log'

export type CloudSpeechProvider = 'deepgram' | 'assemblyai'
export const CLOUD_SPEECH_PROVIDERS: readonly CloudSpeechProvider[] = ['deepgram', 'assemblyai']
/** The providers used when CLOUD_SPEECH_PROVIDERS is not set (see above for why AssemblyAI is not one of them). */
export const DEFAULT_CLOUD_SPEECH_PROVIDERS: readonly CloudSpeechProvider[] = ['deepgram']

/**
 * What the browser needs to open a stream: where, the token (as a query parameter or a WebSocket subprotocol), and how
 * long the stream may run: the voice time the student has left today (`sessionCapSeconds`). AssemblyAI enforces it
 * itself (the token carries it). Deepgram's token has no such field, so the browser closes a Deepgram stream at
 * `maxSeconds` (cloud-recognition.ts) and has to ask for a new grant, which is refused once the time is used up.
 */
export type CloudSpeechGrant = { provider: CloudSpeechProvider; url: string; token: string; maxSeconds: number }

/** The audio the browser sends: 16 kHz mono PCM16 (what the capture worklet makes). */
export const CLOUD_SAMPLE_RATE = 16000

/** The languages voice practice offers (speech.ts); both default models take all of them. */
const VOICE_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'hi', 'zh', 'ja', 'ko'])

const KEY_ENV: Record<CloudSpeechProvider, string> = { deepgram: 'DEEPGRAM_API_KEY', assemblyai: 'ASSEMBLYAI_API_KEY' }

const keyOf = (provider: CloudSpeechProvider, env: NodeJS.ProcessEnv) => env[KEY_ENV[provider]]?.trim() || ''

/** The providers this server can offer, in the order they are tried. */
export function cloudSpeechProviders(env: NodeJS.ProcessEnv = process.env): CloudSpeechProvider[] {
  const named = (env.CLOUD_SPEECH_PROVIDERS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is CloudSpeechProvider => (CLOUD_SPEECH_PROVIDERS as readonly string[]).includes(name))
  const order = named.length > 0 ? [...new Set(named)] : [...DEFAULT_CLOUD_SPEECH_PROVIDERS]
  return order.filter((provider) => keyOf(provider, env).length > 0)
}

export function cloudSpeechConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return cloudSpeechProviders(env).length > 0
}

// ---- Course terms ---------------------------------------------------------------------------

/** At most 100 terms (both providers' limit), each at most 50 characters and 6 words. */
export const MAX_KEYTERMS = 100
const MAX_KEYTERM_CHARS = 50
const MAX_KEYTERM_WORDS = 6
/** Deepgram counts at most 500 tokens across all terms; 1200 characters stays well under it. */
const MAX_KEYTERM_TOTAL_CHARS = 1200

export function keytermsFor(terms: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let total = 0
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim()
    if (term.length < 2 || term.length > MAX_KEYTERM_CHARS) continue
    if (term.split(' ').length > MAX_KEYTERM_WORDS) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    if (total + term.length > MAX_KEYTERM_TOTAL_CHARS) break
    seen.add(key)
    out.push(term)
    total += term.length
    if (out.length >= MAX_KEYTERMS) break
  }
  return out
}

// ---- Deepgram -------------------------------------------------------------------------------

/** Nova-3, unless DEEPGRAM_STREAMING_MODEL names another. $0.0077 a minute, $0.0013 more with course terms. */
export const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'
const DEEPGRAM_STREAM_URL = 'wss://api.deepgram.com/v1/listen'
/**
 * Quiet before Deepgram closes a segment (`speech_final`). The session's own end-of-turn wait (end-of-turn.ts) still
 * decides when the student has finished; this only keeps a thinking pause from splitting a sentence too early.
 */
export const DEEPGRAM_ENDPOINTING_MS = 300

export function deepgramUrl(input: { language: string; terms: string[]; model?: string }): string {
  const params = new URLSearchParams({
    model: input.model || DEFAULT_DEEPGRAM_MODEL,
    encoding: 'linear16',
    sample_rate: String(CLOUD_SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: String(DEEPGRAM_ENDPOINTING_MS),
    // Out of Deepgram's Model Improvement Program: the audio is kept only while the request runs and never used for
    // training (the privacy page promises a student's material is not used to train models). No price change.
    mip_opt_out: 'true',
  })
  const language = input.language.toLowerCase()
  params.set('language', VOICE_LANGUAGES.has(language) ? language : 'en')
  for (const term of keytermsFor(input.terms)) params.append('keyterm', term)
  return `${DEEPGRAM_STREAM_URL}?${params.toString()}`
}

// ---- AssemblyAI -----------------------------------------------------------------------------

/** Universal-3.6 Pro, unless ASSEMBLYAI_STREAMING_MODEL names another. $0.45 an hour, course terms included. */
export const DEFAULT_ASSEMBLYAI_MODEL = 'universal-3-6-pro'
const ASSEMBLYAI_TOKEN_URL = 'https://token.assemblyai.com/v1/token'
const ASSEMBLYAI_STREAM_URL = 'wss://streaming.assemblyai.com/v3/ws'
/** The recognizer closes a segment quickly (a check after 160 ms of quiet, at most 800 ms); the session's wait decides the turn. */
export const MIN_TURN_SILENCE_MS = 160
export const MAX_TURN_SILENCE_MS = 800
/** No audio for this long (a frozen tab) ends the session at AssemblyAI, so it does not run on unheard. */
export const INACTIVITY_TIMEOUT_S = 30

export function assemblyAiUrl(input: { language: string; terms: string[]; model?: string }): string {
  const params = new URLSearchParams({
    speech_model: input.model || DEFAULT_ASSEMBLYAI_MODEL,
    sample_rate: String(CLOUD_SAMPLE_RATE),
    encoding: 'pcm_s16le',
    min_turn_silence: String(MIN_TURN_SILENCE_MS),
    max_turn_silence: String(MAX_TURN_SILENCE_MS),
    inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
  })
  const language = input.language.toLowerCase()
  if (VOICE_LANGUAGES.has(language)) params.set('language_codes', JSON.stringify([language]))
  const keyterms = keytermsFor(input.terms)
  if (keyterms.length > 0) params.set('keyterms_prompt', JSON.stringify(keyterms))
  return `${ASSEMBLYAI_STREAM_URL}?${params.toString()}`
}

/** How long one stream may run: the voice time left today, at least a minute, at most AssemblyAI's 3 h. */
export function sessionCapSeconds(remainingSeconds: number): number {
  const seconds = Number.isFinite(remainingSeconds) ? Math.ceil(remainingSeconds) : 60
  return Math.min(10_800, Math.max(60, seconds))
}

// ---- Minting --------------------------------------------------------------------------------

export class CloudSpeechError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

type MintInput = { maxSessionSeconds: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }

async function readToken(response: Response, field: 'token' | 'access_token'): Promise<string> {
  if (!response.ok) throw new CloudSpeechError(`Token request failed (${response.status})`, 502)
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const token = body?.[field]
  if (typeof token !== 'string' || !token) throw new CloudSpeechError('Token missing', 502)
  return token
}

/** One provider's token: Deepgram's can open a stream for 30 s; AssemblyAI's for 60 s, each stream capped at the time left. */
export async function mintProviderToken(provider: CloudSpeechProvider, input: MintInput): Promise<string> {
  const env = input.env ?? process.env
  const key = keyOf(provider, env)
  if (!key) throw new CloudSpeechError(`${provider} is not configured`, 503)
  const doFetch = input.fetchImpl ?? fetch
  if (provider === 'deepgram') {
    const response = await doFetch(DEEPGRAM_GRANT_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 30 }),
      signal: AbortSignal.timeout(5000),
    })
    return readToken(response, 'access_token')
  }
  const response = await doFetch(ASSEMBLYAI_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product: 'streaming',
      expires_in_seconds: 60,
      max_session_duration_seconds: sessionCapSeconds(input.maxSessionSeconds),
    }),
    signal: AbortSignal.timeout(5000),
  })
  return readToken(response, 'token')
}

/**
 * The first provider (in order, leaving out `exclude`) that mints a token. Throws 503 when none is configured or left,
 * 502 when every one left failed.
 */
export async function mintCloudSpeechGrant(
  input: MintInput & { language: string; terms: string[]; exclude?: string[]; log?: (line: string) => void }
): Promise<CloudSpeechGrant> {
  const env = input.env ?? process.env
  const candidates = cloudSpeechProviders(env).filter((provider) => !input.exclude?.includes(provider))
  if (candidates.length === 0) throw new CloudSpeechError('Cloud speech is not available', 503)
  let lastError: unknown = null
  for (const provider of candidates) {
    try {
      const token = await mintProviderToken(provider, input)
      const url =
        provider === 'deepgram'
          ? deepgramUrl({ language: input.language, terms: input.terms, model: env.DEEPGRAM_STREAMING_MODEL })
          : assemblyAiUrl({ language: input.language, terms: input.terms, model: env.ASSEMBLYAI_STREAMING_MODEL })
      return { provider, url, token, maxSeconds: sessionCapSeconds(input.maxSessionSeconds) }
    } catch (error) {
      lastError = error
      if (input.log) input.log(`${provider} token failed`)
      else logServerError('Voice: a speech token could not be minted', error, { provider })
    }
  }
  throw lastError instanceof CloudSpeechError ? lastError : new CloudSpeechError('Cloud speech is not available', 502)
}
