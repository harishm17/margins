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

import { nextSeenQuestion } from './question-motion'

test('a question that arrives while hydrating (a resume) does not move, then steps do', () => {
  // First render: position 0, not hydrated. Hydration re-render: position 3, hydrated.
  let seen = { index: 0, live: false, motion: '' }
  seen = nextSeenQuestion(seen, 3, true)
  assert.equal(seen.motion, '')
  assert.equal(seen.live, true)
  seen = nextSeenQuestion(seen, 4, true)
  assert.equal(seen.motion, 'animate-slide-in')
  seen = nextSeenQuestion(seen, 4, true)
  assert.equal(seen.motion, 'animate-slide-in', 'the class is kept while the question stays')
  seen = nextSeenQuestion(seen, 1, true)
  assert.equal(seen.motion, 'animate-fade-in')
})
