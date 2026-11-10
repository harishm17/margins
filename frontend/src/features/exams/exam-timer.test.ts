import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseFlagState } from './exam-timer'

describe('parseFlagState', () => {
  it('keeps valid flags and a clamped position', () => {
    assert.deepEqual(parseFlagState('{"flags":[1,1,3,99,"x"],"position":7}', 5), { flags: [1, 3], position: 4 })
  })
  it('falls back for missing or broken values', () => {
    assert.deepEqual(parseFlagState(null, 5), { flags: [], position: 0 })
    assert.deepEqual(parseFlagState('{oops', 5), { flags: [], position: 0 })
  })
})
