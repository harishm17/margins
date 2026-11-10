import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fadeFor, hiddenSteps, } from './fade'
import type { CheckGrade } from '@/lib/reader/checks'

const got: CheckGrade = 'got_it'
const missed: CheckGrade = 'missed'

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
  // A single all-got-it example keeps the level.
  assert.equal(fadeFor('partial', [[got, got]]), 'partial')
  assert.equal(fadeFor('full', [[got]]), 'full')
  assert.equal(fadeFor('full', []), 'full')
})

test('partial hides the last step, the last two from the third example; problem first hides every step', () => {
  for (const [level, example, steps, hidden] of [
    ['partial', 0, 4, [3]],
    ['partial', 1, 4, [3]],
    ['partial', 2, 5, [3, 4]],
    ['partial', 6, 5, [3, 4]],
    ['partial', 2, 1, [0]],
    ['partial', 2, 0, []],
    ['problem_first', 0, 3, [0, 1, 2]],
    ['problem_first', 4, 2, [0, 1]],
  ] as const) {
    assert.deepEqual(hiddenSteps(level, example, steps), hidden, `${level} ${example} ${steps}`)
  }
})
