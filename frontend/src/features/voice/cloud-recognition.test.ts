import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyTurn,
  cloudRecognitionClass,
  createActivityTracker,
  emptyTurnState,
  resultsOf,
  type CloudTurn,
  type DeepgramResults,
  type MicCapture,
} from './cloud-recognition'
import { resultsFromEvent } from './speech'

const turn = (order: number, transcript: string, endOfTurn: boolean, lastEnd?: number): CloudTurn => ({
  type: 'Turn',
  turn_order: order,
  end_of_turn: endOfTurn,
  transcript,
  words: lastEnd === undefined ? [] : [{ text: 'x', start: lastEnd - 200, end: lastEnd }],
})

describe('applyTurn and resultsOf', () => {
  it('keeps one result per turn, interim until the turn ends', () => {
    let state = applyTurn(emptyTurnState(), turn(0, 'Smoke from', false, 800))
    assert.deepEqual(resultsOf(state), [{ transcript: 'Smoke from', isFinal: false }])
    state = applyTurn(state, turn(0, 'Smoke from hundreds of wildfires.', true, 7600))
    state = applyTurn(state, turn(1, 'Skylines', false, 9000))
    assert.deepEqual(resultsOf(state), [
      { transcript: 'Smoke from hundreds of wildfires.', isFinal: true },
      { transcript: 'Skylines', isFinal: false },
    ])
  })

})

describe('createActivityTracker', () => {
  it('needs two loud frames in a row', () => {
    const tracker = createActivityTracker()
    assert.equal(tracker.push(0.001), false)
    assert.equal(tracker.push(0.2), false)
    assert.equal(tracker.push(0.2), true)
    assert.equal(tracker.push(0.001), false)
  })

})

// ---- The recognizer, with a fake socket and capture ------------------------------------------

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    FakeSocket.last = this
  }
  open() {
    this.readyState = 1
    ;(this as unknown as { onopen: (() => void) | null }).onopen?.()
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  message(body: object) {
    this.onmessage?.({ data: JSON.stringify(body) })
  }
}

function fakeCapture(): MicCapture & { emit: (frame: Int16Array) => void } {
  const listeners = new Set<(frame: Int16Array) => void>()
  return {
    start: async () => undefined,
    stop: () => undefined,
    onFrame(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onFailed: () => () => undefined,
    get active() {
      return true
    },
    emit(frame) {
      for (const listener of listeners) listener(frame)
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('cloudRecognitionClass', () => {
  it('streams frames after Begin, reports results and the quiet at the end of a segment', async () => {
    const capture = fakeCapture()
    const silences: number[] = []
    const Recognition = cloudRecognitionClass({
      capture,
      grant: async () => ({ provider: 'assemblyai', url: 'wss://example.test/v3/ws?sample_rate=16000', token: 'tok en' }),
      onSegmentEnd: (ms) => silences.push(ms),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    const seen: { transcript: string; isFinal: boolean }[][] = []
    let started = false
    let ended = false
    recognition.onresult = (event) => seen.push(resultsFromEvent(event))
    recognition.onstart = () => {
      started = true
    }
    recognition.onend = () => {
      ended = true
    }
    recognition.start()
    await tick()
    const socket = FakeSocket.last!
    assert.equal(socket.url, 'wss://example.test/v3/ws?sample_rate=16000&token=tok%20en')

    // Frames before Begin are not sent.
    capture.emit(new Int16Array(1600))
    assert.equal(socket.sent.length, 0)
    socket.readyState = 1
    socket.message({ type: 'Begin', id: 's1' })
    assert.equal(started, true)
    for (let i = 0; i < 20; i += 1) capture.emit(new Int16Array(1600))
    assert.equal(socket.sent.length, 20)

    socket.message(turn(0, 'it is four', false, 1200))
    socket.message(turn(0, 'It is four.', true, 1900))
    assert.deepEqual(seen.at(-1), [{ transcript: 'It is four.', isFinal: true }])
    assert.deepEqual(silences, [800])

    recognition.abort()
    assert.equal(ended, true)
    assert.deepEqual(socket.sent.at(-1), JSON.stringify({ type: 'Terminate' }))
  })

})

// ---- Deepgram ------------------------------------------------------------------------------

const results = (transcript: string, isFinal: boolean, speechFinal: boolean, lastEnd?: number): DeepgramResults => ({
  type: 'Results',
  is_final: isFinal,
  speech_final: speechFinal,
  channel: { alternatives: [{ transcript, words: lastEnd === undefined ? [] : [{ end: lastEnd }] }] },
})

describe('cloudRecognitionClass with Deepgram', () => {
  it('passes the token as the bearer subprotocol, starts on open, and reads Results', async () => {
    const capture = fakeCapture()
    const silences: number[] = []
    const Recognition = cloudRecognitionClass({
      capture,
      grant: async () => ({ provider: 'deepgram', url: 'wss://api.deepgram.test/v1/listen?model=nova-3', token: 'jwt' }),
      onSegmentEnd: (ms) => silences.push(ms),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    const seen: { transcript: string; isFinal: boolean }[][] = []
    let started = false
    recognition.onresult = (event) => seen.push(resultsFromEvent(event))
    recognition.onstart = () => {
      started = true
    }
    recognition.start()
    await tick()
    const socket = FakeSocket.last!
    assert.equal(socket.url, 'wss://api.deepgram.test/v1/listen?model=nova-3')
    assert.deepEqual(socket.protocols, ['bearer', 'jwt'])
    assert.equal(started, false)
    socket.open()
    assert.equal(started, true)
    for (let i = 0; i < 25; i += 1) capture.emit(new Int16Array(1600))
    socket.message(results('it is four', false, false, 1.2))
    socket.message(results('It is four.', true, true, 1.6))
    assert.deepEqual(seen.at(-1), [{ transcript: 'It is four.', isFinal: true }])
    assert.deepEqual(silences, [900])
    recognition.abort()
    assert.deepEqual(socket.sent.at(-1), JSON.stringify({ type: 'CloseStream' }))
  })

  it('a stream refused before it opens names the provider, so the next grant can leave it out', async () => {
    const refused: string[] = []
    const Recognition = cloudRecognitionClass({
      capture: fakeCapture(),
      grant: async () => ({ provider: 'deepgram', url: 'wss://api.deepgram.test/v1/listen?a=1', token: 'jwt' }),
      onRefused: (provider) => refused.push(provider),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    const errors: string[] = []
    recognition.onerror = (event) => errors.push(event.error)
    recognition.start()
    await tick()
    FakeSocket.last!.onclose?.({ code: 1006 })
    assert.deepEqual(refused, ['deepgram'])
    assert.deepEqual(errors, ['cloud-unavailable'])
  })

})

