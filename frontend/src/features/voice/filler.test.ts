import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FILLER_AFTER_MS, FILLER_LINES, fillerWaitMs, pickFiller } from './filler'

describe('pickFiller', () => {
  it('never says the same line twice in a row', () => {
    for (const language of Object.keys(FILLER_LINES)) {
      for (const line of FILLER_LINES[language]) {
        for (const random of [0, 0.3, 0.7, 0.999]) {
          assert.notEqual(pickFiller(language, line, () => random), line, `${language} ${line}`)
        }
      }
    }
  })

})

describe('fillerWaitMs', () => {
  it('is due 1.2 s after the turn ended', () => {
    assert.equal(FILLER_AFTER_MS, 1200)
    assert.equal(fillerWaitMs(1000, 1000), 1200)
    assert.equal(fillerWaitMs(1000, 1900), 300)
    // It is zero when the time has passed.
    assert.equal(fillerWaitMs(1000, 2200), 0)
    assert.equal(fillerWaitMs(1000, 9000), 0)
  })
})
