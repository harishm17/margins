import test from 'node:test'
import assert from 'node:assert/strict'
import { LOOP_STEP_MS, LoopAutoplay, type Clock } from './loop-autoplay'

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = end
  }
  return { clock, advance, pending: () => timers.size }
}

function setup({ steps = 6, enabled = true } = {}) {
  const { clock, advance, pending } = fakeClock()
  const shown: number[] = []
  const autoplay = new LoopAutoplay({ steps, enabled, clock, onAdvance: (index) => shown.push(index) })
  return { autoplay, advance, pending, shown }
}

const STEP = LOOP_STEP_MS

test('nothing happens until the loop is in view', () => {
  const { autoplay, advance, shown } = setup()
  advance(STEP * 3)
  assert.deepEqual(shown, [])
  autoplay.setInView(true)
  advance(STEP - 1)
  assert.deepEqual(shown, [])
  advance(1)
  assert.deepEqual(shown, [1])
  assert.equal(autoplay.state.running, true)
})

test('one pass through every step, back to the first, then it stops and never loops', () => {
  const { autoplay, advance, shown, pending } = setup()
  autoplay.setInView(true)
  advance(STEP * 6)
  assert.deepEqual(shown, [1, 2, 3, 4, 5, 0])
  assert.equal(autoplay.state.active, false)
  assert.equal(autoplay.state.running, false)
  assert.equal(pending(), 0)
  advance(STEP * 10)
  assert.deepEqual(shown, [1, 2, 3, 4, 5, 0])
})

test('the pointer or focus inside pauses it, and the step keeps the time it had left', () => {
  const { autoplay, advance, shown } = setup()
  autoplay.setInView(true)
  advance(5000)
  autoplay.setHovered(true)
  advance(STEP * 2)
  assert.deepEqual(shown, [])
  assert.equal(autoplay.state.running, false)
  assert.equal(autoplay.state.active, true)
  autoplay.setHovered(false)
  advance(1999)
  assert.deepEqual(shown, [])
  advance(1)
  assert.deepEqual(shown, [1])

  autoplay.setFocused(true)
  advance(STEP * 2)
  assert.deepEqual(shown, [1])
  autoplay.setFocused(false)
  advance(STEP)
  assert.deepEqual(shown, [1, 2])
})

test('a hidden tab or the loop scrolling out of view pauses it', () => {
  const { autoplay, advance, shown } = setup()
  autoplay.setInView(true)
  autoplay.setHidden(true)
  advance(STEP * 3)
  assert.deepEqual(shown, [])
  autoplay.setHidden(false)
  advance(STEP)
  assert.deepEqual(shown, [1])
  autoplay.setInView(false)
  advance(STEP * 3)
  assert.deepEqual(shown, [1])
})

test('a click, key or tab choice stops it for good', () => {
  const { autoplay, advance, shown, pending } = setup()
  autoplay.setInView(true)
  advance(STEP)
  autoplay.stop()
  assert.equal(autoplay.state.active, false)
  assert.equal(pending(), 0)
  autoplay.setHovered(false)
  autoplay.setUserPaused(false)
  autoplay.setInView(true)
  advance(STEP * 10)
  assert.deepEqual(shown, [1])
})
