import test from 'node:test'
import assert from 'node:assert/strict'
import { allowanceView } from './allowance'

const resetsAt = '2026-10-29T00:00:00.000Z'

test('a capped allowance shows the share used', () => {
  assert.deepEqual(allowanceView({ usedFraction: 0.42, exhausted: false, resetsAt }), { kind: 'used', percent: 42, exhausted: false })
  assert.deepEqual(allowanceView({ usedFraction: 1, exhausted: true, resetsAt }), { kind: 'used', percent: 100, exhausted: true })
})

test('no per-user cap reads as no limit only when the allowance is known', () => {
  assert.deepEqual(allowanceView({ usedFraction: null, exhausted: false, resetsAt }), { kind: 'unlimited' })
})

test('the global cap with no per-user cap reads as used up', () => {
  assert.deepEqual(allowanceView({ usedFraction: null, exhausted: true, resetsAt }), { kind: 'exhausted' })
})

test('no allowance (the AI service could not be reached) is unknown, not "no limit"', () => {
  assert.deepEqual(allowanceView(null), { kind: 'unknown' })
})
