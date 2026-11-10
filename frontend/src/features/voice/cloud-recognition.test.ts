import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDeepgram,
  applyTurn,
  createRecoveryBudget,
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


  it('learns a steady hum and does not take it for speech', () => {
    const tracker = createActivityTracker()
    for (let i = 0; i < 200; i += 1) tracker.push(0.015)
    assert.equal(tracker.push(0.03), false)
    assert.equal(tracker.push(0.03), false)
    assert.equal(tracker.push(0.2), false)
    assert.equal(tracker.push(0.2), true)
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


  it('reports a dropped stream as a network error, and a refused token as cloud-unavailable', async () => {
    for (const [code, opened, expected] of [
      [1006, true, 'network'],
      [1008, true, 'cloud-unavailable'],
      [1006, false, 'cloud-unavailable'],
    ] as const) {
      const Recognition = cloudRecognitionClass({
        capture: fakeCapture(),
        grant: async () => ({ provider: 'assemblyai', url: 'wss://example.test/ws?a=1', token: 't' }),
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

  it('holds once per segment, so steady noise cannot keep the turn open', async () => {
    const capture = fakeCapture()
    const Recognition = cloudRecognitionClass({
      capture,
      grant: async () => ({ provider: 'assemblyai', url: 'wss://example.test/ws?a=1', token: 't' }),
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

  it('a stream that never opens is given up on (the student talked into a socket that stayed connecting)', async () => {
    const refused: string[] = []
    const Recognition = cloudRecognitionClass({
      capture: fakeCapture(),
      grant: async () => ({ provider: 'deepgram', url: 'wss://api.deepgram.test/v1/listen?a=1', token: 'jwt' }),
      onRefused: (provider) => refused.push(provider),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      connectTimeoutMs: 20,
    })
    const recognition = new Recognition()
    const errors: string[] = []
    let ended = 0
    recognition.onerror = (event) => errors.push(event.error)
    recognition.onend = () => (ended += 1)
    recognition.start()
    await tick()
    const socket = FakeSocket.last!
    // The socket neither opens nor closes.
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(errors, ['cloud-unavailable'])
    assert.deepEqual(refused, ['deepgram'])
    assert.equal(ended, 1)
    assert.equal(socket.readyState, 3, 'the socket is closed')

    // A stream that opens in time is left alone.
    const fine = new Recognition()
    const fineErrors: string[] = []
    fine.onerror = (event) => fineErrors.push(event.error)
    fine.start()
    await tick()
    FakeSocket.last!.open()
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(fineErrors, [])
    fine.abort()
  })

  it('a stream is closed when the voice time it was granted for is used up', async () => {
    // Voice review of PR #90: Deepgram's token only limits when a stream may open, so an open microphone kept a stream
    // running (and billed) past the day's limit. The grant now says how long the stream may run.
    const grantFor = (maxSeconds?: number) =>
      cloudRecognitionClass({
        capture: fakeCapture(),
        grant: async () => ({ provider: 'deepgram', url: 'wss://api.deepgram.test/v1/listen?a=1', token: 'jwt', maxSeconds }),
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
    const capped = new (grantFor(0.03))()
    const errors: string[] = []
    let ended = 0
    capped.onerror = (event) => errors.push(event.error)
    capped.onend = () => (ended += 1)
    capped.start()
    await tick()
    const socket = FakeSocket.last!
    socket.open()
    await new Promise((resolve) => setTimeout(resolve, 80))
    // Closed the graceful way: the recognizer is asked for the words it still holds, then told to close.
    assert.deepEqual(socket.sent, [JSON.stringify({ type: 'Finalize' }), JSON.stringify({ type: 'CloseStream' })])
    assert.deepEqual(errors, [], 'the end of the granted time is not an error: the controller asks for a new stream')
    capped.abort()
    assert.equal(ended, 1)

    // A grant with time left leaves the stream open.
    const open = new (grantFor(600))()
    open.start()
    await tick()
    const kept = FakeSocket.last!
    kept.open()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(kept.sent, [])
    open.abort()
  })
})

describe('applyDeepgram', () => {
  it('keeps the final segments, then one interim, each replaced at its own position', () => {
    let state = emptyTurnState()
    state = applyDeepgram(state, results('smoke from', false, false, 0.8)).state
    state = applyDeepgram(state, results('smoke from hundreds', false, false, 1.4)).state
    assert.deepEqual(resultsOf(state), [{ transcript: 'smoke from hundreds', isFinal: false }])
    const closed = applyDeepgram(state, results('Smoke from hundreds of wildfires.', true, true, 2.1))
    assert.equal(closed.segmentEnd, true)
    assert.equal(closed.state.lastWordEndMs, 2100)
    state = applyDeepgram(closed.state, results('skylines', false, false, 3.0)).state
    assert.deepEqual(resultsOf(state), [
      { transcript: 'Smoke from hundreds of wildfires.', isFinal: true },
      { transcript: 'skylines', isFinal: false },
    ])
  })

  it('keeps an interim that came out empty as an empty final, so positions do not shift', () => {
    let state = applyDeepgram(emptyTurnState(), results('It doubles.', true, false, 1)).state
    state = applyDeepgram(state, results('um', false, false, 1.5)).state
    state = applyDeepgram(state, results('', true, false)).state
    assert.deepEqual(resultsOf(state), [
      { transcript: 'It doubles.', isFinal: true },
      { transcript: '', isFinal: true },
    ])
    // An empty final with nothing in progress adds nothing.
    assert.equal(applyDeepgram(state, results('', true, true)).state.turns.length, 2)
  })

  it('a final without speech_final does not close the segment', () => {
    assert.equal(applyDeepgram(emptyTurnState(), results('Skylines', true, false, 9.5)).segmentEnd, false)
  })
})

describe('createRecoveryBudget', () => {
  it('allows three reopenings in 30 s, then none until the oldest is 30 s old', () => {
    let now = 0
    const budget = createRecoveryBudget({ now: () => now })
    assert.equal(budget.allow(), true)
    now = 1000
    assert.equal(budget.allow(), true)
    now = 2000
    assert.equal(budget.allow(), true)
    now = 3000
    assert.equal(budget.allow(), false)
    now = 30_001
    assert.equal(budget.allow(), true)
  })
})
