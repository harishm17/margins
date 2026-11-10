import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkPromptAreas, promptsV2 } from './prompt-revision'

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

  it('a misspelt area in the variable is an error at start, not an area quietly left on v1', () => {
    // Whole-PR review of #90: PROMPTS_V2=voise was ignored.
    assert.throws(() => checkPromptAreas('tutor, voise'), /voise/)
    assert.doesNotThrow(() => checkPromptAreas(' Tutor, ALL ,'))
    assert.doesNotThrow(() => checkPromptAreas(undefined))
  })
})
