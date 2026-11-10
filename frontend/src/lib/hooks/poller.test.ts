import assert from 'node:assert/strict'
import test from 'node:test'
import { createPoller, type PollerEnv } from './poller'

function fakeEnv() {
  let now = 0
  let hidden = false
  let callback: (() => void) | null = null
  let cleared = false
  let listener: (() => void) | null = null
  const env: PollerEnv = {
    isHidden: () => hidden,
    now: () => now,
    setInterval: (cb) => {
      callback = cb
      return 1
    },
    clearInterval: () => {
      cleared = true
    },
    onVisibilityChange: (cb) => {
      listener = cb
      return () => {
        listener = null
      }
    },
  }
  return {
    env,
    advance(ms: number) {
      now += ms
      callback?.()
    },
    setHidden(value: boolean) {
      hidden = value
      listener?.()
    },
    get running() {
      return callback !== null && !cleared
    },
    get listening() {
      return listener !== null
    },
  }
}

test('ticks once per interval and gives up after maxPolls', () => {
  const clock = fakeEnv()
  let ticks = 0
  let gaveUp = 0
  createPoller({ intervalMs: 1000, maxPolls: 3, onTick: () => (ticks += 1), onGiveUp: () => (gaveUp += 1) }, clock.env)
  for (let i = 0; i < 10; i += 1) clock.advance(1000)
  assert.equal(ticks, 3)
  assert.equal(gaveUp, 1)
  assert.equal(clock.running, false)
  assert.equal(clock.listening, false)
})

test('a hidden tab neither ticks nor spends the cap', () => {
  const clock = fakeEnv()
  let ticks = 0
  createPoller({ intervalMs: 1000, maxPolls: 2, onTick: () => (ticks += 1) }, clock.env)
  clock.setHidden(true)
  for (let i = 0; i < 20; i += 1) clock.advance(1000)
  assert.equal(ticks, 0)
  assert.equal(clock.running, true)
})

test('coming back to the tab asks at once when an interval has passed', () => {
  const clock = fakeEnv()
  let ticks = 0
  createPoller({ intervalMs: 1000, maxPolls: 5, onTick: () => (ticks += 1) }, clock.env)
  clock.setHidden(true)
  clock.advance(5000)
  clock.setHidden(false)
  assert.equal(ticks, 1)
})
