import test from 'node:test'
import assert from 'node:assert/strict'
import { unitForRetry } from './units'

test('a retried add keeps its unit while it exists', () => {
  assert.equal(unitForRetry('u1', ['u1', 'u2'], 'u2'), 'u1')
})

test('a retried add goes to the current target when its unit was deleted', () => {
  assert.equal(unitForRetry('gone', ['u2'], 'u2'), 'u2')
  assert.equal(unitForRetry('gone', [], null), null)
})

test('an add with no unit stays without one unless a target is given', () => {
  assert.equal(unitForRetry(null, ['u1'], null), null)
})
