import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { endOfTurnWaitMs } from './end-of-turn'

describe('endOfTurnWaitMs', () => {
  it('waits 1.2 s after a short answer, 1.5 s after a prediction and 2.2 s after an explanation', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'a bucket' }), 1200)
    assert.equal(endOfTurnWaitMs({ listenFor: 'prediction', text: 'it grows' }), 1500)
    assert.equal(endOfTurnWaitMs({ listenFor: 'explanation', text: 'it maps keys to slots' }), 2200)
    // The short wait also applies when the coach is not waiting for an answer.
    assert.equal(endOfTurnWaitMs({ listenFor: 'none', text: 'thanks' }), 1200)
  })

  it('adds 1.5 s when the last word is a continuation word', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'it is a tree and' }), 2700)
    assert.equal(endOfTurnWaitMs({ listenFor: 'prediction', text: 'I think it grows because' }), 3000)
    // Punctuation and case on the last word are ignored.
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'It is slow, But.' }), 2700)
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'it is slow' }), 1200)
    // A continuation word that is not last does not extend the wait.
    assert.equal(endOfTurnWaitMs({ listenFor: 'short_answer', text: 'the answer is seven' }), 1200)
  })

  it('never goes over the 4 s cap', () => {
    assert.equal(endOfTurnWaitMs({ listenFor: 'explanation', text: 'it works by going to the' }), 3700)
    assert.ok(endOfTurnWaitMs({ listenFor: 'explanation', text: 'and' }) <= 4000)
  })
})
