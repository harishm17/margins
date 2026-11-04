import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { materialsSummary } from './materials-summary'

describe('materialsSummary', () => {
  it('claims every file was read only when nothing needs attention', () => {
    assert.equal(materialsSummary({ ready: 2, working: 0, needsAttention: 0 }), 'Every file here has been read.')
  })
  it('counts a rejected row instead of claiming it was read', () => {
    assert.equal(materialsSummary({ ready: 1, working: 0, needsAttention: 1 }), '1 file ready; 1 file needs attention.')
    assert.equal(materialsSummary({ ready: 2, working: 0, needsAttention: 2 }), '2 files ready; 2 files need attention.')
  })
  it('says what to do when nothing could be read', () => {
    assert.equal(
      materialsSummary({ ready: 0, working: 0, needsAttention: 1 }),
      '1 file needs attention. Remove it, or upload a supported file.'
    )
  })
  it('keeps the leave-the-page note while files are being read, and still mentions a rejected one', () => {
    assert.equal(materialsSummary({ ready: 0, working: 1, needsAttention: 0 }), 'You can leave this page. Files keep being read.')
    assert.equal(
      materialsSummary({ ready: 0, working: 1, needsAttention: 1 }),
      'You can leave this page. Files keep being read. 1 file needs attention.'
    )
  })
})
