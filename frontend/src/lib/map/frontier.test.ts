import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFrontier } from './frontier'

test('frontier means prerequisites at R >= 0.8 and node not solid', () => {
  assert.equal(isFrontier('not_started', [0.8, 0.95]), true)
  assert.equal(isFrontier('shaky', [0.79]), false)
  assert.equal(isFrontier('getting_there', [0.9, 0.5]), false)
  assert.equal(isFrontier('solid', [0.9]), false)
})

test('the ring reads retrievability only: a prerequisite that is Shaky but freshly answered still counts as met (spec §9)', () => {
  // The caller passes each prerequisite's retrievability; the label of the prerequisite plays no part.
  assert.equal(isFrontier('not_started', [0.85]), true)
  assert.equal(isFrontier('not_started', [0.85, 0.5]), false)
})
