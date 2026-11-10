import assert from 'node:assert/strict'
import test from 'node:test'
import { isAttempt } from './take'

test('a take counts from eight characters of the student own words', () => {
  assert.equal(isAttempt('seven c'), false)
  assert.equal(isAttempt('eight ch'), true)
  assert.equal(isAttempt('   short   '), false)
})
