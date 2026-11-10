import assert from 'node:assert/strict'
import test from 'node:test'
import { styleNeedsQuiz } from './quiz-status'
import { startingStyleFor } from './starting-style'

test('only Quiz me and a sprint need the quiz', () => {
  assert.equal(styleNeedsQuiz('topic', 'oral_quiz'), true)
  assert.equal(styleNeedsQuiz('topic', 'teach_back'), false)
  assert.equal(styleNeedsQuiz('topic', 'guided_reading'), false)
  assert.equal(styleNeedsQuiz('sprint', 'oral_quiz'), true)
})

test('a topic with no quiz begins on a style that can run', () => {
  assert.equal(startingStyleFor(true, undefined, true), 'teach_back')
  assert.equal(startingStyleFor(true, undefined, false), 'oral_quiz')
  assert.equal(startingStyleFor(true, 'guided_reading', true), 'guided_reading')
  assert.equal(startingStyleFor(false, undefined, true), 'oral_quiz')
  // The style the link names is kept when its claims are there; with no claims it is Quiz me whatever the link names.
  assert.equal(startingStyleFor(true, 'teach_back'), 'teach_back')
  assert.equal(startingStyleFor(true, 'guided_reading'), 'guided_reading')
  assert.equal(startingStyleFor(true, undefined), 'oral_quiz')
  assert.equal(startingStyleFor(false, 'teach_back'), 'oral_quiz')
  assert.equal(startingStyleFor(false, 'guided_reading'), 'oral_quiz')
})
