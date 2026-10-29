import test from 'node:test'
import assert from 'node:assert/strict'
import { questionMotion } from './question-motion'

test('Next slides in from the right', () => {
  assert.equal(questionMotion(2, 3), 'animate-slide-in')
})

test('Previous slides in from the left', () => {
  assert.equal(questionMotion(3, 2), 'animate-slide-in-back')
})

test('a jump of more than one fades, either way', () => {
  assert.equal(questionMotion(0, 4), 'animate-fade-in')
  assert.equal(questionMotion(5, 1), 'animate-fade-in')
})

test('the same question does not move', () => {
  assert.equal(questionMotion(2, 2), '')
})
