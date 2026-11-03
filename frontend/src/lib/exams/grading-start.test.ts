import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradingJustSubmitted } from './grading-start'

test('an attempt just handed in with no grading job yet is grading about to start; an old one with none did not start', () => {
  const at = new Date('2026-11-02T22:08:17.831Z')
  assert.equal(gradingJustSubmitted(at, new Date(at.getTime() + 10)), true)
  assert.equal(gradingJustSubmitted(at, new Date(at.getTime() + 59_999)), true)
  assert.equal(gradingJustSubmitted(at, new Date(at.getTime() + 60_000)), false)
})
