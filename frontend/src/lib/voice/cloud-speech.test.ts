import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CloudSpeechError,
  assemblyAiUrl,
  cloudSpeechConfigured,
  cloudSpeechProviders,
  deepgramUrl,
  keytermsFor,
  mintCloudSpeechGrant,
  mintProviderToken,
  sessionCapSeconds,
} from './cloud-speech'

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv

describe('cloudSpeechProviders', () => {
  it('offers only Deepgram by default, when it has a key (AssemblyAI trains on audio unless a paid account opts out)', () => {
    assert.deepEqual(cloudSpeechProviders(env({})), [])
    assert.deepEqual(cloudSpeechProviders(env({ ASSEMBLYAI_API_KEY: 'a' })), [])
    assert.deepEqual(cloudSpeechProviders(env({ ASSEMBLYAI_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' })), ['deepgram'])
    assert.deepEqual(cloudSpeechProviders(env({ DEEPGRAM_API_KEY: '  ' })), [])
    assert.equal(cloudSpeechConfigured(env({ DEEPGRAM_API_KEY: 'd' })), true)
  })

  it('follows CLOUD_SPEECH_PROVIDERS for the order, and can leave one out', () => {
    const keys = { ASSEMBLYAI_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' }
    assert.deepEqual(cloudSpeechProviders(env({ ...keys, CLOUD_SPEECH_PROVIDERS: 'assemblyai, deepgram' })), ['assemblyai', 'deepgram'])
    assert.deepEqual(cloudSpeechProviders(env({ ...keys, CLOUD_SPEECH_PROVIDERS: 'assemblyai' })), ['assemblyai'])
    assert.deepEqual(cloudSpeechProviders(env({ ...keys, CLOUD_SPEECH_PROVIDERS: 'deepgram,assemblyai' })), ['deepgram', 'assemblyai'])
    assert.deepEqual(cloudSpeechProviders(env({ ...keys, CLOUD_SPEECH_PROVIDERS: 'nonsense' })), ['deepgram'])
  })
})

describe('keytermsFor', () => {
  it('drops long, wordy and repeated terms and keeps at most 100', () => {
    const terms = ['Bayes theorem', 'bayes Theorem', 'x', 'a'.repeat(51), 'one two three four five six seven', 'prior']
    assert.deepEqual(keytermsFor(terms), ['Bayes theorem', 'prior'])
    assert.equal(keytermsFor(Array.from({ length: 150 }, (_, i) => `t${i}`)).length, 100)
  })

  it('stays well under Deepgram 500-token limit in total', () => {
    const long = Array.from({ length: 100 }, (_, i) => `a fairly long course term ${i}`)
    const kept = keytermsFor(long)
    assert.ok(kept.join('').length <= 1200)
    assert.ok(kept.length < 100)
  })
})

describe('deepgramUrl', () => {
  it('names the model, the audio, the endpointing, the language, the training opt-out and each term', () => {
    const url = new URL(deepgramUrl({ language: 'es', terms: ['teorema de Bayes', 'prior'] }))
    assert.equal(url.origin + url.pathname, 'wss://api.deepgram.com/v1/listen')
    assert.equal(url.searchParams.get('model'), 'nova-3')
    assert.equal(url.searchParams.get('encoding'), 'linear16')
    assert.equal(url.searchParams.get('sample_rate'), '16000')
    assert.equal(url.searchParams.get('interim_results'), 'true')
    assert.equal(url.searchParams.get('endpointing'), '300')
    assert.equal(url.searchParams.get('language'), 'es')
    assert.equal(url.searchParams.get('mip_opt_out'), 'true')
    assert.deepEqual(url.searchParams.getAll('keyterm'), ['teorema de Bayes', 'prior'])
  })

  it('uses English for a language the app does not offer', () => {
    assert.equal(new URL(deepgramUrl({ language: 'xx', terms: [] })).searchParams.get('language'), 'en')
  })
})

describe('assemblyAiUrl', () => {
  it('names the model, the audio, the turn settings, the language and the terms', () => {
    const url = new URL(assemblyAiUrl({ language: 'es', terms: ['teorema de Bayes'] }))
    assert.equal(url.origin + url.pathname, 'wss://streaming.assemblyai.com/v3/ws')
    assert.equal(url.searchParams.get('speech_model'), 'universal-3-6-pro')
    assert.equal(url.searchParams.get('max_turn_silence'), '800')
    assert.equal(url.searchParams.get('language_codes'), '["es"]')
    assert.equal(url.searchParams.get('keyterms_prompt'), '["teorema de Bayes"]')
    assert.equal(url.searchParams.get('token'), null)
  })

  it('leaves out an unknown language and an empty term list', () => {
    const url = new URL(assemblyAiUrl({ language: 'xx', terms: [], model: 'universal-streaming-english' }))
    assert.equal(url.searchParams.get('language_codes'), null)
    assert.equal(url.searchParams.get('keyterms_prompt'), null)
    assert.equal(url.searchParams.get('speech_model'), 'universal-streaming-english')
  })
})

describe('sessionCapSeconds', () => {
  it('is the time left, between a minute and three hours', () => {
    assert.equal(sessionCapSeconds(10), 60)
    assert.equal(sessionCapSeconds(900.2), 901)
    assert.equal(sessionCapSeconds(99_999), 10_800)
    assert.equal(sessionCapSeconds(Number.NaN), 60)
  })
})

type Seen = { url: string; init: RequestInit }
function fakeFetch(answers: Record<string, () => Response>, seen: Seen[] = []) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    const answer = Object.entries(answers).find(([prefix]) => url.startsWith(prefix))
    return answer ? answer[1]() : new Response('no', { status: 404 })
  }) as unknown as typeof fetch
}
const ok = (body: object) => () => new Response(JSON.stringify(body), { status: 200 })
const refused = () => new Response('no', { status: 403 })

describe('mintProviderToken', () => {
  it('asks Deepgram for a 30 s grant with the key as a Token header', async () => {
    const seen: Seen[] = []
    const fetchImpl = fakeFetch({ 'https://api.deepgram.com/v1/auth/grant': ok({ access_token: 'jwt', expires_in: 30 }) }, seen)
    assert.equal(await mintProviderToken('deepgram', { maxSessionSeconds: 600, fetchImpl, env: env({ DEEPGRAM_API_KEY: 'dk' }) }), 'jwt')
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Token dk')
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { ttl_seconds: 30 })
  })

  it('asks AssemblyAI for a one-minute token capped at the time left', async () => {
    const seen: Seen[] = []
    const fetchImpl = fakeFetch({ 'https://token.assemblyai.com/v1/token': ok({ token: 'tok' }) }, seen)
    assert.equal(await mintProviderToken('assemblyai', { maxSessionSeconds: 600, fetchImpl, env: env({ ASSEMBLYAI_API_KEY: 'ak' }) }), 'tok')
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'ak')
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { product: 'streaming', expires_in_seconds: 60, max_session_duration_seconds: 600 })
  })

  it('fails with 503 without a key and 502 when the service refuses', async () => {
    await assert.rejects(mintProviderToken('deepgram', { maxSessionSeconds: 60, env: env({}) }), (error: unknown) => error instanceof CloudSpeechError && error.status === 503)
    const fetchImpl = fakeFetch({ 'https://api.deepgram.com': refused })
    await assert.rejects(
      mintProviderToken('deepgram', { maxSessionSeconds: 60, fetchImpl, env: env({ DEEPGRAM_API_KEY: 'dk' }) }),
      (error: unknown) => error instanceof CloudSpeechError && error.status === 502
    )
  })
})

describe('mintCloudSpeechGrant', () => {
  // Both providers named, as a deployment that adds AssemblyAI would.
  const keys = env({ DEEPGRAM_API_KEY: 'dk', ASSEMBLYAI_API_KEY: 'ak', CLOUD_SPEECH_PROVIDERS: 'deepgram,assemblyai' })
  const both = fakeFetch({
    'https://api.deepgram.com': ok({ access_token: 'jwt' }),
    'https://token.assemblyai.com': ok({ token: 'tok' }),
  })
  const quiet = () => undefined

  it('never reaches AssemblyAI by default, even with its key', async () => {
    const defaults = env({ DEEPGRAM_API_KEY: 'dk', ASSEMBLYAI_API_KEY: 'ak' })
    await assert.rejects(
      mintCloudSpeechGrant({ maxSessionSeconds: 60, language: 'en', terms: [], exclude: ['deepgram'], fetchImpl: both, env: defaults, log: quiet }),
      (error: unknown) => error instanceof CloudSpeechError && error.status === 503
    )
  })

  it('gives Deepgram first, with its URL', async () => {
    const grant = await mintCloudSpeechGrant({ maxSessionSeconds: 600, language: 'en', terms: ['hash'], fetchImpl: both, env: keys, log: quiet })
    assert.equal(grant.provider, 'deepgram')
    assert.equal(grant.token, 'jwt')
    assert.ok(grant.url.startsWith('wss://api.deepgram.com/v1/listen?'))
  })

  it('goes on to AssemblyAI when Deepgram cannot mint, or the browser leaves Deepgram out', async () => {
    const deepgramDown = fakeFetch({ 'https://api.deepgram.com': refused, 'https://token.assemblyai.com': ok({ token: 'tok' }) })
    const lines: string[] = []
    const grant = await mintCloudSpeechGrant({ maxSessionSeconds: 600, language: 'en', terms: [], fetchImpl: deepgramDown, env: keys, log: (line) => lines.push(line) })
    assert.equal(grant.provider, 'assemblyai')
    assert.match(lines[0], /deepgram token failed/)
    const excluded = await mintCloudSpeechGrant({ maxSessionSeconds: 600, language: 'en', terms: [], exclude: ['deepgram'], fetchImpl: both, env: keys, log: quiet })
    assert.equal(excluded.provider, 'assemblyai')
  })

  it('fails with 503 when every provider is left out, and 502 when every one fails', async () => {
    await assert.rejects(
      mintCloudSpeechGrant({ maxSessionSeconds: 60, language: 'en', terms: [], exclude: ['deepgram', 'assemblyai'], fetchImpl: both, env: keys, log: quiet }),
      (error: unknown) => error instanceof CloudSpeechError && error.status === 503
    )
    const allDown = fakeFetch({ 'https://api.deepgram.com': refused, 'https://token.assemblyai.com': refused })
    await assert.rejects(
      mintCloudSpeechGrant({ maxSessionSeconds: 60, language: 'en', terms: [], fetchImpl: allDown, env: keys, log: quiet }),
      (error: unknown) => error instanceof CloudSpeechError && error.status === 502
    )
  })
})
