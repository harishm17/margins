import assert from 'node:assert/strict'
import test from 'node:test'
import { listenFor } from './listen'
import { emptyConceptState } from './teach-back'
import { readCoachState } from './teach-tools'

test('what the session waits for after a coach turn', () => {
  const fresh = readCoachState({})
  assert.equal(listenFor('oral_quiz', fresh, false), 'short_answer')
  assert.equal(listenFor('teach_back', fresh, false), 'explanation')
  const example = readCoachState({ teach: { current: 'c', askedTurn: 1, concepts: { c: { ...emptyConceptState(), exampleAsked: true } } } })
  assert.equal(listenFor('teach_back', example, false), 'prediction')
  const done = readCoachState({ teach: { current: 'c', askedTurn: 1, concepts: { c: { ...emptyConceptState(), exampleAsked: true, outcome: 'explained' } } } })
  assert.equal(listenFor('teach_back', done, false), 'explanation')
  assert.equal(listenFor('guided_reading', readCoachState({ guided: { stage: 'predicting', index: 0 } }), false), 'prediction')
  assert.equal(listenFor('guided_reading', readCoachState({ guided: { stage: 'taught', index: 0 } }), false), 'short_answer')
  assert.equal(listenFor('teach_back', example, true), 'none')
})
