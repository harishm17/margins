import assert from 'node:assert/strict'
import test from 'node:test'
import { pathSteps } from './path-steps'

const base = { hasConcepts: true, warmupReady: true, warmupDone: false, preparingConcepts: false }

test('a topic with concepts and a warm-up bank has the whole path', () => {
  assert.deepEqual(pathSteps(base), ['warmup', 'read', 'recall', 'practice', 'quiz'])
})

test('no warm-up bank and none taken hides Warm-up; a warm-up already taken stays', () => {
  assert.deepEqual(pathSteps({ ...base, warmupReady: false }), ['read', 'recall', 'practice', 'quiz'])
  assert.deepEqual(pathSteps({ ...base, warmupReady: false, warmupDone: true }), ['warmup', 'read', 'recall', 'practice', 'quiz'])
})

test('a topic being prepared keeps the five steps in place until it settles', () => {
  // Nothing is written yet, then the concepts, then the warm-up: the path is the same at each of the three moments.
  const whole = ['warmup', 'read', 'recall', 'practice', 'quiz']
  assert.deepEqual(pathSteps({ hasConcepts: false, warmupReady: false, warmupDone: false, preparingConcepts: false, preparingEntry: true }), whole)
  assert.deepEqual(pathSteps({ hasConcepts: true, warmupReady: false, warmupDone: false, preparingConcepts: false, preparingEntry: true }), whole)
  assert.deepEqual(pathSteps({ ...base, preparingEntry: true }), whole)
  // Once it has settled the steps that cannot work are left out again.
  assert.deepEqual(pathSteps({ hasConcepts: false, warmupReady: false, warmupDone: false, preparingConcepts: false, preparingEntry: false }), ['read', 'practice', 'quiz'])
})
