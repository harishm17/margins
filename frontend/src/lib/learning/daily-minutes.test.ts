import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dailyMinutesProblem, dailyMinutesSchema } from './plan-settings'

test('a custom daily time must be a whole number inside the saved range, with the reason in words', () => {
  assert.equal(dailyMinutesProblem(45), null)
  assert.equal(dailyMinutesProblem(10), null)
  assert.equal(dailyMinutesProblem(600), null)
  assert.equal(dailyMinutesProblem(Number.NaN), 'Enter a whole number of minutes.')
  assert.equal(dailyMinutesProblem(12.5), 'Enter a whole number of minutes.')
  assert.equal(dailyMinutesProblem(5), 'Use 10 to 600 minutes.')
  assert.equal(dailyMinutesProblem(601), 'Use 10 to 600 minutes.')
})

test('anything the field accepts is accepted by the API schema too, and the reverse', () => {
  for (const minutes of [9, 10, 45, 600, 601]) {
    assert.equal(dailyMinutesProblem(minutes) === null, dailyMinutesSchema.safeParse(minutes).success, String(minutes))
  }
})
