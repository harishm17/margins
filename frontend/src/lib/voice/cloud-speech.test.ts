import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  CloudSpeechError,
  cloudSpeechConfigured,
  cloudSpeechUrl,
  keytermsFor,
  mintCloudSpeechToken,
  sessionCapSeconds,
} from './cloud-speech'

describe('cloudSpeechConfigured', () => {
  it('needs a non-empty key', () => {
    assert.equal(cloudSpeechConfigured({} as unknown as NodeJS.ProcessEnv), false)
    assert.equal(cloudSpeechConfigured({ ASSEMBLYAI_API_KEY: '  ' } as unknown as NodeJS.ProcessEnv), false)
    assert.equal(cloudSpeechConfigured({ ASSEMBLYAI_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv), true)
  })
})

describe('keytermsFor', () => {
  it('drops long, wordy and repeated terms and keeps at most 100', () => {
    const terms = ['Bayes theorem', 'bayes Theorem', 'x', 'a'.repeat(51), 'one two three four five six seven', 'prior']
    assert.deepEqual(keytermsFor(terms), ['Bayes theorem', 'prior'])
    assert.equal(keytermsFor(Array.from({ length: 150 }, (_, i) => `term ${i}`)).length, 100)
  })
})

describe('cloudSpeechUrl', () => {
  it('names the model, the audio, the turn settings, the language and the terms', () => {
    const url = new URL(cloudSpeechUrl({ language: 'es', terms: ['teorema de Bayes'] }))
    assert.equal(url.origin + url.pathname, 'wss://streaming.assemblyai.com/v3/ws')
    assert.equal(url.searchParams.get('speech_model'), 'universal-3-6-pro')
    assert.equal(url.searchParams.get('sample_rate'), '16000')
    assert.equal(url.searchParams.get('encoding'), 'pcm_s16le')
    assert.equal(url.searchParams.get('max_turn_silence'), '800')
    assert.equal(url.searchParams.get('language_codes'), '["es"]')
    assert.equal(url.searchParams.get('keyterms_prompt'), '["teorema de Bayes"]')
    assert.equal(url.searchParams.get('token'), null)
  })

  it('leaves out an unknown language and an empty term list', () => {
    const url = new URL(cloudSpeechUrl({ language: 'xx', terms: [], model: 'universal-streaming-english' }))
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

describe('mintCloudSpeechToken', () => {
  const saved = process.env.ASSEMBLYAI_API_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.ASSEMBLYAI_API_KEY
    else process.env.ASSEMBLYAI_API_KEY = saved
  })

  it('asks for a one-minute streaming token capped at the time left', async () => {
    process.env.ASSEMBLYAI_API_KEY = 'secret'
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ token: 'tok' }), { status: 200 })
    }) as unknown as typeof fetch
    assert.equal(await mintCloudSpeechToken({ maxSessionSeconds: 600, fetchImpl }), 'tok')
    assert.equal(seen!.url, 'https://token.assemblyai.com/v1/token')
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'secret')
    assert.deepEqual(JSON.parse(String(seen!.init.body)), {
      product: 'streaming',
      expires_in_seconds: 60,
      max_session_duration_seconds: 600,
    })
  })

  it('fails with 503 without a key and 502 when the service refuses', async () => {
    delete process.env.ASSEMBLYAI_API_KEY
    await assert.rejects(mintCloudSpeechToken({ maxSessionSeconds: 60 }), (error: unknown) => error instanceof CloudSpeechError && error.status === 503)
    process.env.ASSEMBLYAI_API_KEY = 'secret'
    const refused = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch
    await assert.rejects(mintCloudSpeechToken({ maxSessionSeconds: 60, fetchImpl: refused }), (error: unknown) => error instanceof CloudSpeechError && error.status === 502)
  })
})
