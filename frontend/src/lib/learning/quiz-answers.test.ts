import test from 'node:test'
import assert from 'node:assert/strict'
import { answersForGrader, answersForStorage, answersToSend, normalizeAnswers, plainAnswers } from './quiz-answers'

test('keeps confidence and thinking', () => {
  const normalized = normalizeAnswers({
    '0': { answer: 'B', confidence: 0.75, thinking: 'It was the queue one.' },
    '1': 'A',
  })
  assert.deepEqual(normalized['0'], { answer: 'B', confidence: 0.75, thinking: 'It was the queue one.' })
  assert.deepEqual(answersForGrader(normalized), { '0': { answer: 'B', thinking: 'It was the queue one.' }, '1': 'A' })
  assert.deepEqual(answersForStorage(normalized)['0'], normalized['0'])
  assert.equal(answersForStorage(normalized)['1'], 'A')
})

test('keeps the chosen confidence level next to its value, and drops a bad one', () => {
  const normalized = normalizeAnswers({
    '0': { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' },
    '1': { answer: 'False', confidence: 0.5, confidenceLevel: 'nonsense' },
    '2': { answer: 'True', confidenceLevel: 'certain' },
  })
  assert.deepEqual(normalized['0'], { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' })
  assert.deepEqual(normalized['1'], { answer: 'False', confidence: 0.5 })
  assert.deepEqual(normalized['2'], { answer: 'True' })
})

test('an "I don\'t know" keeps its flag, has no text and no confidence', () => {
  const normalized = normalizeAnswers({
    '0': { answer: 'leftover', idk: true, confidence: 0.95, confidenceLevel: 'certain', thinking: 'hm' },
    '1': { answer: 'B', idk: false },
  })
  assert.deepEqual(normalized['0'], { answer: '', idk: true })
  assert.deepEqual(normalized['1'], { answer: 'B' })
  assert.deepEqual(plainAnswers(normalized), { '0': '', '1': 'B' })
})

test('what is sent keeps the "I don\'t know" answers and leaves blanks out', () => {
  const sent = answersToSend({ '0': { answer: 'B' }, '1': { answer: '', idk: true }, '2': { answer: ' ' } })
  assert.deepEqual(Object.keys(sent), ['0', '1'])
})
