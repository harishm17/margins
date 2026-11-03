import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanTerms, enableOnDevice, isAutomatedBrowser, onDeviceReady, speechDestination, MAX_PHRASES, PHRASE_BOOST } from './on-device'

class Phrase {
  constructor(
    public phrase: string,
    public boost: number
  ) {}
}

function fakeRecognition(status: string | Error | 'hang', extras: { processLocally?: boolean; phrases?: boolean } = {}) {
  const calls: unknown[] = []
  class Recognition {
    static available(options: unknown) {
      calls.push(options)
      if (status === 'hang') return new Promise<string>(() => undefined)
      return status instanceof Error ? Promise.reject(status) : Promise.resolve(status)
    }
  }
  const prototype = Recognition.prototype as Record<string, unknown>
  if (extras.processLocally !== false) prototype.processLocally = false
  if (extras.phrases !== false) prototype.phrases = []
  return { Recognition, calls }
}

describe('onDeviceReady', () => {
  it('is true only when everything is there and the language pack is installed', async () => {
    const { Recognition, calls } = fakeRecognition('available')
    assert.equal(await onDeviceReady({ Recognition, Phrase }, 'en-US'), true)
    assert.deepEqual(calls, [{ langs: ['en-US'], processLocally: true }])
  })

  it('is false when the pack still has to be downloaded: the app never starts a download', async () => {
    for (const status of ['downloadable', 'downloading', 'unavailable']) {
      const { Recognition } = fakeRecognition(status)
      assert.equal(await onDeviceReady({ Recognition, Phrase }, 'en-US'), false, status)
    }
  })

  it('is false in a browser without processLocally, phrases, available() or the phrase class', async () => {
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition('available', { processLocally: false }).Recognition, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition('available', { phrases: false }).Recognition, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition('available').Recognition, Phrase: undefined }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: class {}, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: null, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady(null, 'en-US'), false)
  })

  it('is false when available() throws, rejects or never answers', async () => {
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition(new Error('no')).Recognition, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition('hang').Recognition, Phrase }, 'en-US', 20), false)
  })
})

describe('cleanTerms', () => {
  it('trims, drops duplicates and junk, and stops at 100', () => {
    assert.deepEqual(cleanTerms([' hash table ', 'Hash Table', 'x', '', 5, null, 'load factor']), ['hash table', 'load factor'])
    assert.deepEqual(cleanTerms('nope'), [])
    assert.equal(cleanTerms(Array.from({ length: 300 }, (_, i) => `term ${i}`)).length, MAX_PHRASES)
    assert.deepEqual(cleanTerms(['a'.repeat(200)]), [])
  })
})

describe('enableOnDevice', () => {
  it('turns on processLocally and gives the terms as phrases', () => {
    const recognition: { processLocally?: boolean; phrases?: Phrase[] } = {}
    assert.equal(enableOnDevice(recognition, { Recognition: null, Phrase }, ['hash table', 'bucket']), true)
    assert.equal(recognition.processLocally, true)
    assert.deepEqual(recognition.phrases, [new Phrase('hash table', PHRASE_BOOST), new Phrase('bucket', PHRASE_BOOST)])
  })

  it('fills the list in place when the browser refuses a replacement', () => {
    const list: Phrase[] = []
    const recognition = {
      processLocally: false,
      get phrases() {
        return list
      },
      set phrases(_value: Phrase[]) {
        throw new TypeError('read only')
      },
    }
    assert.equal(enableOnDevice(recognition, { Recognition: null, Phrase }, ['bucket']), true)
    assert.equal(list.length, 1)
  })

  it('goes back to the normal recognizer when the browser refuses', () => {
    const recognition = {
      _local: false,
      get processLocally() {
        return this._local
      },
      set processLocally(value: boolean) {
        if (value) throw new TypeError('no')
        this._local = value
      },
    }
    assert.equal(enableOnDevice(recognition, { Recognition: null, Phrase }, ['bucket']), false)
    assert.equal(recognition.processLocally, false)
  })
})

describe('speechDestination', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const edge = `${chrome} Edg/142.0.0.0`
  const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1'

  it('says Google for Chrome, Apple for Safari and for every browser on an iPhone', () => {
    assert.equal(speechDestination({ userAgent: chrome, ios: false, onDevice: false }), 'google')
    assert.equal(speechDestination({ userAgent: safari, ios: false, onDevice: false }), 'apple')
    assert.equal(speechDestination({ userAgent: iosChrome, ios: true, onDevice: false }), 'apple')
  })

  it('names no vendor it is not sure of', () => {
    assert.equal(speechDestination({ userAgent: edge, ios: false, onDevice: false }), 'browser')
    assert.equal(speechDestination({ userAgent: 'curl/8', ios: false, onDevice: false }), 'browser')
  })

  it('says the audio stays on the device when on-device recognition is on', () => {
    assert.equal(speechDestination({ userAgent: chrome, ios: false, onDevice: true }), 'device')
  })
})

describe('isAutomatedBrowser', () => {
  it('spots a browser driven by a test tool, where available() would crash the page', () => {
    assert.equal(isAutomatedBrowser({ webdriver: true, userAgent: 'Mozilla/5.0 Chrome/142' }), true)
    assert.equal(isAutomatedBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/156.0.0.0 Safari/537.36' }), true)
    assert.equal(isAutomatedBrowser({ webdriver: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142.0.0.0 Safari/537.36' }), false)
  })
})
