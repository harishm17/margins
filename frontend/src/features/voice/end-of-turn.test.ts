import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONTINUATION_WORDS, defaultListenFor, endOfTurnWaitMs, endsOnContinuationWord, lastWordOf } from './end-of-turn'

describe('endOfTurnWaitMs', () => {
  it('waits 1.2 s after a short answer, 1.5 s after a prediction and 2.2 s after an explanation', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'a bucket' }), 1200)
    assert.equal(endOfTurnWaitMs({ listenFor: 'prediction', text: 'it grows' }), 1500)
    assert.equal(endOfTurnWaitMs({ listenFor: 'explanation', text: 'it maps keys to slots' }), 2200)
  })

  it('uses the short wait when the coach is not waiting for an answer', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'none', text: 'thanks' }), 1200)
  })

  it('adds 1.5 s when the last word is a continuation word', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'it is a tree and' }), 2700)
    assert.equal(endOfTurnWaitMs({ listenFor: 'prediction', text: 'I think it grows because' }), 3000)
  })

  it('never goes over the 4 s cap', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'explanation', text: 'it works by going to the' }), 3700)
    assert.ok(endOfTurnWaitMs({ listenFor: 'explanation', text: 'and' }) <= 4000)
  })

  it('ignores punctuation and case on the last word', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'It is slow, But.' }), 2700)
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'it is slow' }), 1200)
  })

  it('does not extend for a continuation word that is not last', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'the answer is seven' }), 1200)
  })
})

describe('continuation words', () => {
  it('has the words from the spec', () => {
    for (const word of ['and', 'but', 'so', 'because', 'or', 'then', 'which', 'that', 'if', 'like', 'um', 'uh', 'the', 'a', 'of', 'to', 'with']) {
      assert.ok(CONTINUATION_WORDS.has(word), word)
    }
    assert.equal(CONTINUATION_WORDS.size, 17)
  })

  it('finds the last word', () => {
    assert.equal(lastWordOf('  Hello there, UM...  '), 'um')
    assert.equal(lastWordOf(''), '')
    assert.equal(lastWordOf('...'), '')
    assert.equal(endsOnContinuationWord('it depends on the'), true)
    assert.equal(endsOnContinuationWord('it depends on that one'), false)
  })
})

describe('defaultListenFor', () => {
  it('guesses by style when the server has not said', () => {
    assert.equal(defaultListenFor('oral_quiz'), 'short_answer')
    assert.equal(defaultListenFor('teach_back'), 'explanation')
    assert.equal(defaultListenFor('guided_reading'), 'prediction')
  })
})
