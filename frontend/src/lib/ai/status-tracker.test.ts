import test from 'node:test'
import assert from 'node:assert/strict'
import { createStatusTracker } from './status-tracker'

function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

test('an answer to a request sent before a report never overwrites it', () => {
  const time = clock()
  const tracker = createStatusTracker({ cacheMs: 10_000, now: time.now })
  const poll = tracker.begin(false)
  const freshBefore = tracker.begin(true)
  tracker.noteReport()
  time.advance(30_000)
  assert.equal(tracker.accepts(poll), false)
  assert.equal(tracker.accepts(freshBefore), false)
})

test('a fresh answer asked for after the report is the truth, whatever it says', () => {
  const time = clock()
  const tracker = createStatusTracker({ cacheMs: 10_000, now: time.now })
  tracker.noteReport()
  const fresh = tracker.begin(true)
  assert.equal(tracker.accepts(fresh), true)
})

test('a possibly cached answer (a poll, a server render) waits out the cache window after a report', () => {
  const time = clock()
  const tracker = createStatusTracker({ cacheMs: 10_000, now: time.now })
  tracker.noteReport()
  const poll = tracker.begin(false)
  assert.equal(tracker.accepts(poll), false)
  assert.equal(tracker.acceptsServerRender(), false)
  time.advance(10_001)
  assert.equal(tracker.accepts(tracker.begin(false)), true)
  assert.equal(tracker.acceptsServerRender(), true)
})
