import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fadeFor, fadeStart, hiddenSteps, hidesWhy, warmupScoreOf } from './fade'
import type { CheckGrade } from '@/lib/reader/checks'

const got: CheckGrade = 'got_it'
const missed: CheckGrade = 'missed'
const partly: CheckGrade = 'partly'

test('fade starts full for band 0, partial for 1, problem_first for 2', () => {
  assert.equal(fadeStart(0), 'full')
  assert.equal(fadeStart(1), 'partial')
  assert.equal(fadeStart(2), 'problem_first')
})

test('one missed moves towards full', () => {
  assert.equal(fadeFor('problem_first', [[got, missed]]), 'partial')
  assert.equal(fadeFor('partial', [[missed]]), 'full')
  assert.equal(fadeFor('full', [[missed]]), 'full')
  // One level per example: two missed examples in a row are two levels.
  assert.equal(fadeFor('problem_first', [[missed], [missed]]), 'full')
})

test('two all-got-it examples move towards problem first', () => {
  assert.equal(fadeFor('full', [[got, got], [got]]), 'partial')
  assert.equal(fadeFor('partial', [[got], [got, got]]), 'problem_first')
  assert.equal(fadeFor('problem_first', [[got], [got]]), 'problem_first')
  // And one level more for each example that keeps getting it.
  assert.equal(fadeFor('full', [[got], [got], [got]]), 'problem_first')
})

test('one all-got-it example keeps the level', () => {
  assert.equal(fadeFor('partial', [[got, got]]), 'partial')
  assert.equal(fadeFor('full', [[got]]), 'full')
  assert.equal(fadeFor('full', []), 'full')
})

test('partly, or an example with nothing hidden, neither adds nor removes support', () => {
  assert.equal(fadeFor('partial', [[got], [got, partly]]), 'partial')
  assert.equal(fadeFor('partial', [[], []]), 'partial')
  // A miss in the middle resets the run: support comes back at once, and removing it starts over.
  assert.equal(fadeFor('partial', [[got], [missed], [got]]), 'full')
})

test('the first example is shown at the start level and a later one at fadeFor', () => {
  assert.equal(fadeFor(fadeStart(1), []), 'partial')
})

test('full hides why on every example and nothing else', () => {
  assert.equal(hidesWhy('full', 0), true)
  assert.equal(hidesWhy('full', 3), true)
  assert.equal(hidesWhy('partial', 0), false)
  assert.equal(hidesWhy('problem_first', 0), false)
  assert.deepEqual(hiddenSteps('full', 0, 4), [])
  assert.deepEqual(hiddenSteps('full', 5, 4), [])
})

test('partial hides the last step, the last two from the third example', () => {
  assert.deepEqual(hiddenSteps('partial', 0, 4), [3])
  assert.deepEqual(hiddenSteps('partial', 1, 4), [3])
  assert.deepEqual(hiddenSteps('partial', 2, 5), [3, 4])
  assert.deepEqual(hiddenSteps('partial', 6, 5), [3, 4])
  assert.deepEqual(hiddenSteps('partial', 2, 1), [0])
  assert.deepEqual(hiddenSteps('partial', 2, 0), [])
})

test('problem first hides every step', () => {
  assert.deepEqual(hiddenSteps('problem_first', 0, 3), [0, 1, 2])
  assert.deepEqual(hiddenSteps('problem_first', 4, 2), [0, 1])
})

test('the warm-up score is the share of answers that were right and not guessed', () => {
  const sure = { confidence: 0.75, confidenceLevel: 'fairly' }
  assert.equal(warmupScoreOf(null), null)
  assert.equal(warmupScoreOf([]), null)
  assert.equal(warmupScoreOf([{ conceptIds: [], correct: true, ...sure }, { conceptIds: [], correct: false, ...sure }, { conceptIds: [], correct: true, ...sure }, { conceptIds: [], correct: true, ...sure }]), 0.75)
})

test('guessed right warm-up answer is not ahead', () => {
  // A right answer marked Guessing counts as wrong (spec 5.1): luck is not evidence of knowing.
  const guess = { confidence: 0.25, confidenceLevel: 'guess' }
  const sure = { confidence: 0.75, confidenceLevel: 'fairly' }
  assert.equal(warmupScoreOf([{ conceptIds: [], correct: true, ...guess }, { conceptIds: [], correct: true, ...guess }, { conceptIds: [], correct: true, ...guess }]), 0)
  assert.equal(warmupScoreOf([{ conceptIds: [], correct: true, ...guess }, { conceptIds: [], correct: true, ...sure }]), 0.5)
  // A right answer that was unsure, but not a guess, still counts.
  assert.equal(warmupScoreOf([{ conceptIds: [], correct: true, confidence: 0.5, confidenceLevel: 'unsure' }]), 1)
})
