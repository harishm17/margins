import test from 'node:test'
import assert from 'node:assert/strict'
import { answersForGrader, answersForStorage, answersToSend, countAnswered, isAnswered, normalizeAnswers, plainAnswers } from './quiz-answers'

test('accepts legacy string answers', () => {
  const normalized = normalizeAnswers({ '0': 'B', '1': 'because caching' })
  assert.deepEqual(normalized, { '0': { answer: 'B' }, '1': { answer: 'because caching' } })
  assert.deepEqual(plainAnswers(normalized), { '0': 'B', '1': 'because caching' })
})

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

test('drops confidence out of range', () => {
  const normalized = normalizeAnswers({
    '0': { answer: 'B', confidence: 1.5 },
    '1': { answer: 'C', confidence: -0.1 },
    '2': { answer: 'D', confidence: Number.NaN },
    '3': { answer: 'A', confidence: 0 },
  })
  assert.deepEqual(normalized['0'], { answer: 'B' })
  assert.deepEqual(normalized['1'], { answer: 'C' })
  assert.deepEqual(normalized['2'], { answer: 'D' })
  assert.deepEqual(normalized['3'], { answer: 'A', confidence: 0 })
})

test('ignores entries that are not answers and empty thinking', () => {
  assert.deepEqual(normalizeAnswers(null), {})
  assert.deepEqual(normalizeAnswers({ '0': 5, '1': { nope: 1 }, '2': { answer: 'x', thinking: '  ' } }), { '2': { answer: 'x' } })
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

test('isAnswered counts an "I don\'t know" and not an empty box', () => {
  assert.equal(isAnswered({ answer: '', idk: true }), true)
  assert.equal(isAnswered({ answer: '  ' }), false)
  assert.equal(isAnswered({ answer: 'B' }), true)
  assert.equal(isAnswered(undefined), false)
  assert.equal(countAnswered({ '0': { answer: 'B' }, '1': { answer: '', idk: true }, '2': { answer: '' } }), 2)
})

test('what is sent keeps the "I don\'t know" answers and leaves blanks out', () => {
  const sent = answersToSend({ '0': { answer: 'B' }, '1': { answer: '', idk: true }, '2': { answer: ' ' } })
  assert.deepEqual(Object.keys(sent), ['0', '1'])
})
