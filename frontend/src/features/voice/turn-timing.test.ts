import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildMetrics, buildTiming, emptyClock, type TurnClock } from './turn-timing'

const clock = (patch: Partial<TurnClock>): TurnClock => ({ ...emptyClock(), start: 1000, ...patch })

describe('buildTiming', () => {
  it('measures from the request to the first event, sentence and audio', () => {
    const timing = buildTiming(clock({ endpointWaitMs: 1203.4, firstEvent: 1180.2, firstSentence: 2950.7, firstSpeak: 3300 }))
    assert.deepEqual(timing, {
      endpointWaitMs: 1203,
      requestToFirstEventMs: 180,
      requestToFirstSentenceMs: 1951,
      requestToFirstAudioMs: 2300,
      interrupted: false,
    })
    // It also says when the student interrupted.
    assert.equal(buildTiming(clock({ interrupted: true })).interrupted, true)
  })

  it('leaves out what was not measured: a typed answer has no wait, a muted coach has no audio', () => {
    assert.deepEqual(buildTiming(clock({ firstEvent: 1100, firstSentence: 1500 })), {
      requestToFirstEventMs: 100,
      requestToFirstSentenceMs: 500,
      interrupted: false,
    })
  })

  it('never reports a negative or missing time', () => {
    const timing = buildTiming(clock({ firstEvent: 900, firstSentence: Number.NaN, endpointWaitMs: -5 }))
    assert.deepEqual(timing, { interrupted: false })
  })
})

describe('buildMetrics', () => {
  it('fills the first-token, first-audio and total times, the speech time, the tool time and the interrupt count', () => {
    const metrics = buildMetrics(
      clock({ firstText: 1900, firstSpeak: 2400, doneAt: 3100, speechMs: 4200.4, workingAt: 1150, afterWorkingAt: 1850, interrupted: true })
    )
    assert.deepEqual(metrics, { ttftMs: 900, ttfaMs: 1400, responseMs: 2100, speechMs: 4200, toolLatencyMs: 700, interrupts: 1 })
  })

  it('leaves out interrupts, speech and tool time when there is nothing to say', () => {
    assert.deepEqual(buildMetrics(clock({ firstText: 1500, doneAt: 2000 })), { ttftMs: 500, responseMs: 1000 })
  })

  it('has no tool time without a working event', () => {
    assert.equal(buildMetrics(clock({ afterWorkingAt: 2000 })).toolLatencyMs, undefined)
  })
})
