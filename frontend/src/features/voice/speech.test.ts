import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultLanguageCode, isIosPlatform, newFinalWords, pickVoice, scoreVoice, speechTimeLimitMs, type VoiceInfo } from './speech'

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

  it('never picks a voice for another language', () => {
    assert.equal(pickVoice(voices, 'fr-FR'), null)
    assert.equal(scoreVoice({ name: 'Monica', lang: 'es-ES' }, 'en-US'), -1)
  })

  it('avoids novelty and robotic voices when something else exists', () => {
    const picked = pickVoice(voices.filter((voice) => ['Albert', 'eSpeak English', 'Samantha'].includes(voice.name)), 'en-US')
    assert.equal(picked?.name, 'Samantha')
  })

})

describe('languages', () => {

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

  it('gives a long sentence without spaces time to be said (a Chinese sentence got four seconds whatever its length)', () => {
    const sentence = '熵是系统无序程度的度量，在孤立系统中它永远不会减少，这就是热力学第二定律的内容。'
    const english = 'Entropy measures disorder, and in an isolated system it never decreases, which is the second law.'
    assert.ok(speechTimeLimitMs(sentence, 1) > 12_000, `${speechTimeLimitMs(sentence, 1)} ms`)
    // A sentence with spaces is timed as before.
    assert.equal(speechTimeLimitMs(english, 1), 16 * 700 + 2000)
    assert.equal(speechTimeLimitMs('Yes.', 1), 4000)
  })

  it('does not take a Mac, Android or Windows for iOS', () => {
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }), false)
    assert.equal(isIosPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }), false)
  })
})
