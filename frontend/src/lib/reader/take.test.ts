import assert from 'node:assert/strict'
import test from 'node:test'
import { isAttempt, MIN_TAKE_CHARS } from './take'

test('a take counts from eight characters of the student own words', () => {
  assert.equal(MIN_TAKE_CHARS, 8)
  assert.equal(isAttempt('seven c'), false)
  assert.equal(isAttempt('eight ch'), true)
  assert.equal(isAttempt('   short   '), false)
  assert.equal(isAttempt(''), false)
})
