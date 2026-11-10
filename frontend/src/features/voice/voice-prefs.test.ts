import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampRate, DEFAULT_PREFS, getVoicePrefs, parsePrefs, resolveVoice, resetVoicePrefsForTest, setVoicePrefs, voiceKey } from './voice-prefs'
import type { VoiceInfo } from './speech'

const voices: VoiceInfo[] = [
  { name: 'Albert', lang: 'en-US', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true, default: true },
  { name: 'Samantha (Enhanced)', lang: 'en-US', localService: true },
  { name: 'Google UK English Female', lang: 'en-GB', localService: false },
  { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US', localService: false },
  { name: 'Monica', lang: 'es-ES', localService: true },
]

describe('clampRate', () => {
  it('keeps the rate between 0.8 and 1.4', () => {
    assert.equal(clampRate(0.5), 0.8)
    assert.equal(clampRate(2), 1.4)
    assert.equal(clampRate(1.15), 1.15)
    assert.equal(clampRate(Number.NaN), 1)
  })
})

describe('parsePrefs', () => {

  it('uses cloud recognition unless the student chose the browser (older saved settings have no choice)', () => {
    assert.equal(parsePrefs('{"speak":true}').recognition, 'cloud')
    assert.equal(parsePrefs('{"recognition":"nope"}').recognition, 'cloud')
  })

  it('falls back to the defaults for nothing, junk or the wrong shape', () => {
    for (const raw of [null, undefined, '', 'nope', '5', '[]', 'null']) assert.deepEqual(parsePrefs(raw), DEFAULT_PREFS, String(raw))
  })

  it('repairs single bad fields', () => {
    assert.deepEqual(parsePrefs('{"rate":9,"speak":"no","voices":{"en-US":5,"fr-FR":"Amelie|fr-FR"}}'), {
      speak: true,
      rate: 1.4,
      voices: { 'fr-FR': 'Amelie|fr-FR' },
      recognition: 'cloud',
    })
  })
})

describe('voice picking', () => {
  it('picks the best voice for the language by itself: Natural, Neural, Premium or Enhanced first', () => {
    assert.equal(resolveVoice(voices, 'en-US', null)?.name, 'Microsoft Jenny Online (Natural) - English (United States)')
    const apple = voices.filter((voice) => voice.name.startsWith('Samantha') || voice.name === 'Albert')
    assert.equal(resolveVoice(apple, 'en-US', null)?.name, 'Samantha (Enhanced)')
  })

  it('uses the chosen voice while it is installed and fits the language', () => {
    assert.equal(resolveVoice(voices, 'en-US', voiceKey({ name: 'Samantha', lang: 'en-US' }))?.name, 'Samantha')
    assert.equal(resolveVoice(voices, 'en-US', 'Gone|en-US')?.name, 'Microsoft Jenny Online (Natural) - English (United States)')
    assert.equal(resolveVoice(voices, 'en-US', voiceKey({ name: 'Monica', lang: 'es-ES' }))?.name, 'Microsoft Jenny Online (Natural) - English (United States)')
  })

})

describe('the store', () => {
  it('keeps the settings and tells listeners', () => {
    resetVoicePrefsForTest()
    // No window here: the defaults hold and a change still reaches subscribers.
    assert.deepEqual(getVoicePrefs(), DEFAULT_PREFS)
    setVoicePrefs({ rate: 1.3, speak: false, voice: { tag: 'en-US', key: 'Samantha|en-US' } })
    assert.deepEqual(getVoicePrefs(), { speak: false, rate: 1.3, voices: { 'en-US': 'Samantha|en-US' }, recognition: 'cloud' })
    setVoicePrefs({ voice: { tag: 'en-US', key: null } })
    assert.deepEqual(getVoicePrefs().voices, {})
    resetVoicePrefsForTest()
  })
})
