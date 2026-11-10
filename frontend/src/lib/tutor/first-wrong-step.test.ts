import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstWrongStep } from './first-wrong-step'

const steps = [{ answer: '12' }, { answer: '30' }, { answer: '7.5' }]

test('firstWrongStep finds the first missing authored value', () => {
  // Step 1 (12) is there, step 2 (30) is not, and a wrong number follows.
  assert.equal(firstWrongStep('12 items, then 12 * 3 = 36, so 36 / 4.8 = 7.5', steps), 1)
  // The first step's value is missing while a later one is there.
  assert.equal(firstWrongStep('I got 30 and then 7.5', steps), 0)
})

test('firstWrongStep respects tolerance', () => {
  const tight = [{ answer: '10', tolerance: 0.1 }, { answer: '20', tolerance: 0.1 }]
  // 10.05 is within 0.1 of 10, 20.5 is not within 0.1 of 20.
  assert.equal(firstWrongStep('10.05 and 20.5', tight), 1)
  assert.equal(firstWrongStep('10.05 and 20.05', tight), null)
  // Without a tolerance the check is within 1%.
  assert.equal(firstWrongStep('100.5', [{ answer: '100' }, { answer: '5' }]), null)
  assert.equal(firstWrongStep('103 then 9', [{ answer: '100' }, { answer: '5' }]), 0)
})

test('firstWrongStep returns null when it cannot decide', () => {
  // Every authored value is there: nothing is wrong.
  assert.equal(firstWrongStep('12, 30, 7.5', steps), null)
  // Only earlier steps are done and nothing else is written: the next step is unanswered, not wrong.
  assert.equal(firstWrongStep('12 and 30 so far', steps), null)
  // Answers that are not numbers cannot be located.
  assert.equal(firstWrongStep('42', [{ answer: 'B' }, { answer: 'depth-first search' }]), null)
})

test('firstWrongStep ignores numbers the problem itself states', () => {
  const keyed = [{ answer: '8' }, { answer: '20' }]
  const givens = 'Ana has 5 apples and Ben has 3. How many do they have together?'
  // Copying the givens is not a wrong number: only the first step is done, nothing else is written.
  assert.equal(firstWrongStep('5 and 3, so 8', keyed, givens), null)
  // Without the givens the same working reads as stray numbers.
  assert.equal(firstWrongStep('5 and 3, so 8', keyed), 1)
  // A real wrong number still counts.
  assert.equal(firstWrongStep('5 and 3, so 9', keyed, givens), 0)
  // A given that is also an answer is kept as an answer.
  assert.equal(firstWrongStep('3', [{ answer: '3' }, { answer: '20' }], givens), null)
})
