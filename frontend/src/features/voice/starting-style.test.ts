import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startingStyleFor } from './starting-style'

describe('startingStyleFor', () => {
  it('keeps the style the link names when its claims are there', () => {
    assert.equal(startingStyleFor(true, 'teach_back'), 'teach_back')
    assert.equal(startingStyleFor(true, 'guided_reading'), 'guided_reading')
  })
  it('is Quiz me when the link names none', () => {
    assert.equal(startingStyleFor(true, undefined), 'oral_quiz')
  })
  it('is Quiz me, whatever the link names, when the claims are missing', () => {
    assert.equal(startingStyleFor(false, 'teach_back'), 'oral_quiz')
    assert.equal(startingStyleFor(false, 'guided_reading'), 'oral_quiz')
  })
})
