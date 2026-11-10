import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { materialsSummary } from './materials-summary'

describe('materialsSummary', () => {
  it('claims every file was read only when nothing needs attention', () => {
    assert.equal(materialsSummary({ ready: 2, working: 0, needsAttention: 0 }), 'Every file here has been read.')
  })
  it('counts a rejected row instead of claiming it was read', () => {
    assert.equal(materialsSummary({ ready: 1, working: 0, needsAttention: 1 }), '1 file ready; 1 file needs attention.')
  })
})
