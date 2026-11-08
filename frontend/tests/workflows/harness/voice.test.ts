import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { progressOf, statedRoundSize } from './voice'

describe('the voice progress line', () => {
  it('reads the question on screen and the size of the set', () => {
    assert.deepEqual(progressOf('Question 2 of 7'), { at: 2, of: 7 })
  })

  it('is null when the line names no question (the coach is still opening)', () => {
    assert.equal(progressOf('Voice practice'), null)
  })
})

describe('the size a quick round states before it starts (V5)', () => {
  it('reads the count it states, whether the maximum or the real one', () => {
    assert.equal(statedRoundSize('Up to 12 questions from your 3 weakest topics, about 12 minutes.'), 12)
    assert.equal(statedRoundSize('4 questions from Sorting and Hashing, about 4 minutes.'), 4)
  })

  it('reads one question', () => {
    assert.equal(statedRoundSize('1 question from Sorting, about 1 minute.'), 1)
  })

  it('is null when the line states no count', () => {
    assert.equal(statedRoundSize('Questions from your weakest topics.'), null)
  })
})
