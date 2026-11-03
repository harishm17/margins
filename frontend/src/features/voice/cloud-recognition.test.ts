import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyTurn,
  cloudRecognitionClass,
  createActivityTracker,
  emptyTurnState,
  resultsOf,
  rmsOf,
  silenceAfterLastWordMs,
  toResultEvent,
  type CloudTurn,
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

  it('takes the end of speech from the partials, not from the stretched final', () => {
    let state = applyTurn(emptyTurnState(), turn(0, 'the answer is four', false, 6250))
    state = applyTurn(state, turn(0, 'The answer is four.', true, 6900))
    assert.equal(state.lastWordEndMs, 6250)
  })

  it('uses the final words when no partial came', () => {
    const state = applyTurn(emptyTurnState(), turn(0, 'Yes.', true, 1200))
    assert.equal(state.lastWordEndMs, 1200)
  })

  it('holds the last segment open while new speech has no words yet, without adding a result', () => {
    let state = applyTurn(emptyTurnState(), turn(0, 'It doubles.', true, 1000))
    state = { ...state, pendingVoice: true }
    assert.deepEqual(resultsOf(state), [{ transcript: 'It doubles.', isFinal: false }])
    // The words arrive at the next position: the hold ends and the segment is final again.
    state = applyTurn(state, turn(1, 'because', false, 2500))
    assert.equal(state.pendingVoice, false)
    assert.deepEqual(resultsOf(state), [
      { transcript: 'It doubles.', isFinal: true },
      { transcript: 'because', isFinal: false },
    ])
  })

  it('reads the same as a browser result event', () => {
    const results = [
      { transcript: 'one', isFinal: true },
      { transcript: 'two', isFinal: false },
    ]
    assert.deepEqual(resultsFromEvent(toResultEvent(results)), results)
  })
})

describe('silenceAfterLastWordMs', () => {
  it('is the audio sent after the last word', () => {
    assert.equal(silenceAfterLastWordMs(7100, 6250), 850)
    assert.equal(silenceAfterLastWordMs(6000, 6250), 0)
    assert.equal(silenceAfterLastWordMs(6000, null), 0)
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

  it('learns a steady hum and does not take it for speech', () => {
    const tracker = createActivityTracker()
    for (let i = 0; i < 200; i += 1) tracker.push(0.015)
    assert.equal(tracker.push(0.03), false)
    assert.equal(tracker.push(0.03), false)
    assert.equal(tracker.push(0.2), false)
    assert.equal(tracker.push(0.2), true)
  })
})

describe('rmsOf', () => {
  it('is 0 for silence and about 0.5 for a half-scale square wave', () => {
    assert.equal(rmsOf(new Int16Array(1600)), 0)
    const square = new Int16Array(1600).map((_, i) => (i % 2 === 0 ? 16384 : -16384))
    assert.ok(Math.abs(rmsOf(square) - 0.5) < 0.001)
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
  constructor(readonly url: string) {
    FakeSocket.last = this
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
      grant: async () => ({ url: 'wss://example.test/v3/ws?sample_rate=16000', token: 'tok en' }),
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

  it('reports cloud-unavailable when no grant can be had', async () => {
    const Recognition = cloudRecognitionClass({
      capture: fakeCapture(),
      grant: async () => {
        throw new Error('503')
      },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    const errors: string[] = []
    let ended = false
    recognition.onerror = (event) => errors.push(event.error)
    recognition.onend = () => {
      ended = true
    }
    recognition.start()
    await tick()
    assert.deepEqual(errors, ['cloud-unavailable'])
    assert.equal(ended, true)
  })

  it('reports a dropped stream as a network error, and a refused token as cloud-unavailable', async () => {
    for (const [code, opened, expected] of [
      [1006, true, 'network'],
      [1008, true, 'cloud-unavailable'],
      [1006, false, 'cloud-unavailable'],
    ] as const) {
      const Recognition = cloudRecognitionClass({
        capture: fakeCapture(),
        grant: async () => ({ url: 'wss://example.test/ws?a=1', token: 't' }),
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
      const recognition = new Recognition()
      const errors: string[] = []
      recognition.onerror = (event) => errors.push(event.error)
      recognition.start()
      await tick()
      const socket = FakeSocket.last!
      if (opened) {
        socket.readyState = 1
        socket.message({ type: 'Begin' })
      }
      socket.onclose?.({ code })
      assert.deepEqual(errors, [expected], `${code} ${opened}`)
    }
  })

  it('holds the wait open when the student starts again after a finished segment', async () => {
    const capture = fakeCapture()
    const Recognition = cloudRecognitionClass({
      capture,
      grant: async () => ({ url: 'wss://example.test/ws?a=1', token: 't' }),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    const seen: { transcript: string; isFinal: boolean }[][] = []
    recognition.onresult = (event) => seen.push(resultsFromEvent(event))
    recognition.start()
    await tick()
    const socket = FakeSocket.last!
    socket.readyState = 1
    socket.message({ type: 'Begin' })
    socket.message(turn(0, 'It doubles.', true, 900))
    const loud = new Int16Array(1600).fill(8000)
    capture.emit(loud)
    capture.emit(loud)
    assert.deepEqual(seen.at(-1), [{ transcript: 'It doubles.', isFinal: false }])
    recognition.abort()
  })

  it('holds once per segment, so steady noise cannot keep the turn open', async () => {
    const capture = fakeCapture()
    const Recognition = cloudRecognitionClass({
      capture,
      grant: async () => ({ url: 'wss://example.test/ws?a=1', token: 't' }),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const recognition = new Recognition()
    let emits = 0
    recognition.onresult = () => {
      emits += 1
    }
    recognition.start()
    await tick()
    const socket = FakeSocket.last!
    socket.readyState = 1
    socket.message({ type: 'Begin' })
    socket.message(turn(0, 'It doubles.', true, 900))
    const loud = new Int16Array(1600).fill(8000)
    for (let i = 0; i < 4; i += 1) capture.emit(loud)
    assert.equal(emits, 2)
    await new Promise((resolve) => setTimeout(resolve, 2100))
    // The hold ran out (3 emits); the noise goes on, and no second hold starts for the same segment.
    for (let i = 0; i < 10; i += 1) capture.emit(loud)
    assert.equal(emits, 3)
    recognition.abort()
  })
})
