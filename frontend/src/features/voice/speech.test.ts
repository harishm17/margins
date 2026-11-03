import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultLanguageCode, isIosPlatform, languageTag, newFinalWords, pickVoice, scoreVoice, VOICE_LANGUAGES, type VoiceInfo } from './speech'

const voices: VoiceInfo[] = [
  { name: 'Albert', lang: 'en-US', localService: true },
  { name: 'eSpeak English', lang: 'en', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true, default: true },
  { name: 'Google UK English Female', lang: 'en-GB', localService: false },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false },
  { name: 'Monica', lang: 'es-ES', localService: true },
  { name: 'Google español de Estados Unidos', lang: 'es-US', localService: false },
]

describe('pickVoice', () => {
  it('prefers a natural or neural voice in the exact language', () => {
    assert.equal(pickVoice(voices, 'en-US')?.name, 'Microsoft Aria Online (Natural) - English (United States)')
  })

  it('falls back to a same-language voice from another region', () => {
    const onlyUk = voices.filter((voice) => voice.name.startsWith('Google UK'))
    assert.equal(pickVoice(onlyUk, 'en-US')?.name, 'Google UK English Female')
  })

  it('never picks a voice for another language', () => {
    assert.equal(pickVoice(voices, 'fr-FR'), null)
    assert.equal(scoreVoice({ name: 'Monica', lang: 'es-ES' }, 'en-US'), -1)
  })

  it('avoids novelty and robotic voices when something else exists', () => {
    const picked = pickVoice(voices.filter((voice) => ['Albert', 'eSpeak English', 'Samantha'].includes(voice.name)), 'en-US')
    assert.equal(picked?.name, 'Samantha')
  })

  it('handles underscores in the voice language (older Android)', () => {
    assert.equal(pickVoice([{ name: 'x', lang: 'es_ES' }], 'es-ES')?.name, 'x')
  })

  it('picks the Google voice for Spanish over the plain local one', () => {
    assert.equal(pickVoice(voices, 'es-ES')?.name, 'Google español de Estados Unidos')
  })
})

describe('languages', () => {
  it('maps codes to browser tags and keeps unknown codes', () => {
    assert.equal(languageTag('en'), 'en-US')
    assert.equal(languageTag('hi'), 'hi-IN')
    assert.equal(languageTag('sv'), 'sv')
  })

  it('every code is accepted by the server pattern', () => {
    for (const language of VOICE_LANGUAGES) assert.match(language.code, /^[a-z]{2,8}$/i)
  })

  it('defaults to the browser language when listed, else English', () => {
    assert.equal(defaultLanguageCode('es-MX'), 'es')
    assert.equal(defaultLanguageCode('sv-SE'), 'en')
    assert.equal(defaultLanguageCode(undefined), 'en')
  })
})

describe('dictation', () => {
  it('hands over only the final words not taken yet', () => {
    const parts = [
      { transcript: ' the table ', isFinal: true },
      { transcript: 'rebuilds when', isFinal: true },
      { transcript: 'it is full', isFinal: false },
    ]
    assert.deepEqual(newFinalWords(parts, 0), { words: ['the table', 'rebuilds when'], taken: 2 })
    assert.deepEqual(newFinalWords(parts, 2), { words: [], taken: 2 })
    assert.deepEqual(newFinalWords([...parts.slice(0, 2), { transcript: 'it is full', isFinal: true }], 2), { words: ['it is full'], taken: 3 })
  })
})

describe('isIosPlatform', () => {
  it('spots iPhone, iPad and an iPad that says it is a Mac', () => {
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }), true)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true)
  })

  it('does not take a Mac, Android or Windows for iOS', () => {
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }), false)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }), false)
  })
})
