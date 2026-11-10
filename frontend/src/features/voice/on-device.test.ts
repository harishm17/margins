import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { enableOnDevice, onDeviceReady, speechDestination, PHRASE_BOOST } from './on-device'

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

  it('is false when available() throws, rejects or never answers', async () => {
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition(new Error('no')).Recognition, Phrase }, 'en-US'), false)
    assert.equal(await onDeviceReady({ Recognition: fakeRecognition('hang').Recognition, Phrase }, 'en-US', 20), false)
  })
})

describe('enableOnDevice', () => {
  it('turns on processLocally and gives the terms as phrases', () => {
    const recognition: { processLocally?: boolean; phrases?: Phrase[] } = {}
    assert.equal(enableOnDevice(recognition, { Recognition: null, Phrase }, ['hash table', 'bucket']), true)
    assert.equal(recognition.processLocally, true)
    assert.deepEqual(recognition.phrases, [new Phrase('hash table', PHRASE_BOOST), new Phrase('bucket', PHRASE_BOOST)])
  })

})

describe('speechDestination', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1'

  it('says Google for Chrome, Apple for Safari and for every browser on an iPhone', () => {
    assert.equal(speechDestination({ userAgent: chrome, ios: false, onDevice: false }), 'google')
    assert.equal(speechDestination({ userAgent: safari, ios: false, onDevice: false }), 'apple')
    assert.equal(speechDestination({ userAgent: iosChrome, ios: true, onDevice: false }), 'apple')
  })

})
