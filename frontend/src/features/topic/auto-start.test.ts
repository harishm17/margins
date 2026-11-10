import test from 'node:test'
import assert from 'node:assert/strict'
import { autoStartDecision, autoStartRequest, prefetchRequest, type AutoStartInput } from './auto-start'

const base: AutoStartInput = {
  preparing: true,
  activeChecked: true,
  alreadyStarted: false,
  notesPresent: false,
  notesRunning: false,
}

test('a topic opened without notes starts them', () => {
  assert.equal(autoStartDecision(base), 'start')
})

test('a notes job that is already running is followed, not duplicated (a refresh mid-write)', () => {
  assert.equal(autoStartDecision({ ...base, notesRunning: true }), 'skip')
})

test('it starts once per page: after the first request it only waits for it', () => {
  assert.equal(autoStartDecision({ ...base, alreadyStarted: true }), 'wait')
})

test('a topic with a failed attempt, or one the student dismissed, is not restarted', () => {
  assert.equal(autoStartDecision({ ...base, preparing: false }), 'skip')
})

test('nothing is started while AI is unavailable or the allowance is used', () => {
  assert.equal(autoStartDecision({ ...base, aiBlocked: true }), 'skip')
})

test('auto start requests concepts on first open', () => {
  assert.deepEqual(autoStartRequest(), {
    contentType: 'concepts',
    preferences: { prepare_rest: true, only_if_missing: true },
  })
})
