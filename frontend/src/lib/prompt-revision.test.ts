import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promptsV2 } from './prompt-revision'

describe('promptsV2', () => {
  it('is off when the variable is empty or missing', () => {
    assert.equal(promptsV2('voice', ''), false)
    assert.equal(promptsV2('voice', '  '), false)
    assert.equal(promptsV2('voice', undefined), false)
  })

  it('is on for a listed area, in any case and with spaces', () => {
    assert.equal(promptsV2('voice', 'voice'), true)
    assert.equal(promptsV2('voice', 'tutor, Voice'), true)
    assert.equal(promptsV2('tutor', 'voice'), false)
  })

  it('"all" turns every area on', () => {
    assert.equal(promptsV2('voice', 'all'), true)
    assert.equal(promptsV2('grading', 'ALL'), true)
  })

  it('refuses an area it does not know', () => {
    assert.throws(() => promptsV2('nope' as never, 'all'))
  })
})
