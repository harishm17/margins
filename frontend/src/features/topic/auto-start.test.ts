import test from 'node:test'
import assert from 'node:assert/strict'
import { autoStartDecision, type AutoStartInput } from './auto-start'

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

test('it waits until the running jobs have been looked at', () => {
  assert.equal(autoStartDecision({ ...base, activeChecked: false }), 'wait')
})

test('a notes job that is already running is followed, not duplicated (a refresh mid-write)', () => {
  assert.equal(autoStartDecision({ ...base, notesRunning: true }), 'skip')
})

test('a topic that has notes is left alone', () => {
  assert.equal(autoStartDecision({ ...base, notesPresent: true }), 'skip')
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
