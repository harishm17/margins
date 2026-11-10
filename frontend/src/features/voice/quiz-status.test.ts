import assert from 'node:assert/strict'
import test from 'node:test'
import { quizMissingCopy, styleNeedsQuiz } from './quiz-status'
import { startingStyleFor } from './starting-style'

test('only Quiz me and a sprint need the quiz', () => {
  assert.equal(styleNeedsQuiz('topic', 'oral_quiz'), true)
  assert.equal(styleNeedsQuiz('topic', 'teach_back'), false)
  assert.equal(styleNeedsQuiz('topic', 'guided_reading'), false)
  assert.equal(styleNeedsQuiz('sprint', 'oral_quiz'), true)
})

test('with no quiz the lobby says so and offers to write one', () => {
  const copy = quizMissingCopy('topic', { state: 'missing', reason: 'no_quiz', total: 0 }, true)
  assert.match(copy.text, /doesn't have a quiz yet/)
  assert.match(copy.text, /Teach it back and Read it with me work without a quiz/)
  assert.equal(copy.action, 'Write the quiz')
})

test('with a quiz of calculations it says how many questions and why they are left out', () => {
  const copy = quizMissingCopy('topic', { state: 'missing', reason: 'not_speakable', total: 8 }, false)
  assert.match(copy.text, /8 questions/)
  assert.match(copy.text, /can't be asked out loud/)
  assert.doesNotMatch(copy.text, /Teach it back/)
  assert.equal(copy.action, 'Open the quiz')
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
