import test from 'node:test'
import assert from 'node:assert/strict'
import { LOOP_AUTOPLAY, LOOP_STEP_MS, LoopAutoplay, loopInView, pauseKeepsFocusOnBlur, shouldRestoreFocusToStep, type AutoplayState, type Clock } from './loop-autoplay'

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
  const states: AutoplayState[] = []
  const autoplay = new LoopAutoplay({ steps, enabled, clock, onAdvance: (index) => shown.push(index), onState: (state) => states.push(state) })
  return { autoplay, advance, pending, shown, states }
}

const STEP = LOOP_STEP_MS

test('the switch is on and each step stays about 7 seconds', () => {
  assert.equal(LOOP_AUTOPLAY, true)
  assert.equal(LOOP_STEP_MS, 7000)
})

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

test('the pause button pauses and play carries on (it is not an interaction that stops it)', () => {
  const { autoplay, advance, shown } = setup()
  autoplay.setInView(true)
  autoplay.setUserPaused(true)
  assert.equal(autoplay.state.userPaused, true)
  advance(STEP * 3)
  assert.deepEqual(shown, [])
  autoplay.setUserPaused(false)
  advance(STEP)
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

test('off when not enabled (a phone, reduced motion), and off for good when the conditions change', () => {
  const off = setup({ enabled: false })
  off.autoplay.setInView(true)
  off.advance(STEP * 10)
  assert.deepEqual(off.shown, [])
  assert.equal(off.autoplay.state.active, false)

  const changed = setup()
  changed.autoplay.setInView(true)
  changed.autoplay.disable()
  changed.advance(STEP * 10)
  assert.deepEqual(changed.shown, [])
  assert.equal(changed.pending(), 0)
})

test('a single step has nothing to advance to', () => {
  const { autoplay, advance, shown } = setup({ steps: 1 })
  autoplay.setInView(true)
  advance(STEP * 3)
  assert.deepEqual(shown, [])
})

test('the state tells the UI whether the line is filling', () => {
  const { autoplay, states } = setup()
  autoplay.setInView(true)
  assert.deepEqual(states.at(-1), { index: 0, running: true, active: true, userPaused: false })
  autoplay.setHovered(true)
  assert.deepEqual(states.at(-1), { index: 0, running: false, active: true, userPaused: false })
})

test('in view means at least half shown, whatever isIntersecting says', () => {
  assert.equal(loopInView({ isIntersecting: true, intersectionRatio: 0.2 }), false)
  assert.equal(loopInView({ isIntersecting: true, intersectionRatio: 0.49 }), false)
  assert.equal(loopInView({ isIntersecting: true, intersectionRatio: 0.5 }), true)
  assert.equal(loopInView({ isIntersecting: true, intersectionRatio: 1 }), true)
  assert.equal(loopInView({ isIntersecting: false, intersectionRatio: 0.6 }), false)
})

test('a blur keeps the pause button focused only when the whole window lost focus', () => {
  // Switching to another application: the document no longer has focus, the button still holds it.
  assert.equal(pauseKeepsFocusOnBlur(false), true)
  // Focus moved to another element in the page: the document still has focus.
  assert.equal(pauseKeepsFocusOnBlur(true), false)
})

test('focus moves to the open step only from the pause button and only when it fell to the body', () => {
  assert.equal(shouldRestoreFocusToStep(true, true), true)
  // The visitor moved focus to another element: never take it.
  assert.equal(shouldRestoreFocusToStep(true, false), false)
  // The button never held focus.
  assert.equal(shouldRestoreFocusToStep(false, true), false)
  assert.equal(shouldRestoreFocusToStep(false, false), false)
})
