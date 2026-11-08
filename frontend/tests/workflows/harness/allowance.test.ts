import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowanceStateGaps, inPlainTerms, jobsSettled, minutesToReset, overshoot } from './allowance'

describe('how far a day went past the allowance (K4, S2)', () => {
  it('is within one job when jobs run one at a time', () => {
    // $0.01 left: the first job crosses the limit and the next is refused.
    assert.deepEqual(overshoot(7.99, [0.12], 8).moreThanOneJob, false)
  })

  it('is more than one job when several start together on the last cents', () => {
    const { over, moreThanOneJob } = overshoot(7.99, [0.12, 0.1, 0.15], 8)
    assert.equal(moreThanOneJob, true)
    assert.ok(Math.abs(over - 0.36) < 1e-9)
  })

  it('is nothing when the day stays under the limit', () => {
    assert.deepEqual(overshoot(2, [0.5, 0.5], 8), { over: 0, moreThanOneJob: false })
  })

  it('is nothing when no job ran', () => {
    assert.deepEqual(overshoot(7.99, [], 8), { over: 0, moreThanOneJob: false })
  })
})

describe('the shared "allowance reached" state on a surface', () => {
  it('is complete with the sentence and the reset time', () => {
    assert.deepEqual(allowanceStateGaps("You've used today's AI allowance. It resets tomorrow at 4:00 PM."), [])
  })

  it('takes a curly apostrophe and a reset later today', () => {
    assert.deepEqual(allowanceStateGaps('You’ve used today’s AI allowance. It resets at 4:00 PM.'), [])
  })

  it('names both parts on a surface with its own wording', () => {
    assert.deepEqual(allowanceStateGaps("Today's allowance used"), ['the sentence "You\'ve used today\'s AI allowance"', 'when it resets'])
  })

  it('takes the sentence as an alert title, with no full stop', () => {
    assert.deepEqual(allowanceStateGaps("You've used today's AI allowance It resets at 4:00 PM."), [])
  })

  it('names the reset time when only the sentence shows', () => {
    assert.deepEqual(allowanceStateGaps("You've used today's AI allowance."), ['when it resets'])
  })
})

describe('an allowance summary in plain terms (D2)', () => {
  it('is not a percent alone', () => {
    assert.equal(inPlainTerms('0% used'), false)
    assert.equal(inPlainTerms("Today's allowance used"), false)
  })

  it('is what is left, in things a student does', () => {
    assert.equal(inPlainTerms('About 6 topics or 40 practice problems left today'), true)
    assert.equal(inPlainTerms('Enough for about 1 topic today'), true)
  })
})

describe('minutes until the allowance resets', () => {
  it('counts to the next midnight UTC', () => {
    assert.equal(minutesToReset(new Date('2026-11-08T23:30:00Z')), 30)
    assert.equal(minutesToReset(new Date('2026-11-09T00:00:00Z')), 24 * 60)
  })
})

describe('content jobs for topics opened together', () => {
  it('are not settled before every topic has started one', () => {
    assert.equal(jobsSettled({ asked: 3, started: 0, running: 0, waitedMs: 1000 }), false)
    assert.equal(jobsSettled({ asked: 3, started: 2, running: 0, waitedMs: 5000 }), false)
  })

  it('are settled once every topic started one and none still runs', () => {
    assert.equal(jobsSettled({ asked: 3, started: 3, running: 0, waitedMs: 5000 }), true)
    assert.equal(jobsSettled({ asked: 3, started: 3, running: 1, waitedMs: 5000 }), false)
  })

  it('stop waiting for a topic that never starts after a minute: it was refused before any job', () => {
    assert.equal(jobsSettled({ asked: 3, started: 1, running: 0, waitedMs: 61_000 }), true)
    assert.equal(jobsSettled({ asked: 3, started: 1, running: 1, waitedMs: 61_000 }), false)
  })
})
