import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CloudSpeechError,
  cloudSpeechConfigured,
  cloudSpeechProviders,
  deepgramUrl,
  mintCloudSpeechGrant,
  mintProviderToken,
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

  it('goes on to AssemblyAI when Deepgram cannot mint, or the browser leaves Deepgram out', async () => {
    const deepgramDown = fakeFetch({ 'https://api.deepgram.com': refused, 'https://token.assemblyai.com': ok({ token: 'tok' }) })
    const lines: string[] = []
    const grant = await mintCloudSpeechGrant({ maxSessionSeconds: 600, language: 'en', terms: [], fetchImpl: deepgramDown, env: keys, log: (line) => lines.push(line) })
    assert.equal(grant.provider, 'assemblyai')
    assert.match(lines[0], /deepgram token failed/)
    const excluded = await mintCloudSpeechGrant({ maxSessionSeconds: 600, language: 'en', terms: [], exclude: ['deepgram'], fetchImpl: both, env: keys, log: quiet })
    assert.equal(excluded.provider, 'assemblyai')
  })

})
