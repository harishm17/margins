import test from 'node:test'
import assert from 'node:assert/strict'
import { joinAnswers, splitAnswers, submitDialogCopy, submitSummary } from './exam-answers'

test('answers split into text and confidence, and join back the same', () => {
  const stored = { '0': { answer: 'B', confidence: 0.75 }, '1': 'true', '2': 4 }
  const { answers, confidence } = splitAnswers(stored)
  assert.deepEqual(answers, { '0': 'B', '1': 'true', '2': '4' })
  assert.deepEqual(confidence, { '0': 0.75 })
  assert.deepEqual(joinAnswers(answers, confidence), { '0': { answer: 'B', confidence: 0.75 }, '1': 'true', '2': '4' })
})

test('the chosen level travels with the confidence and comes back', () => {
  const stored = { '0': { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' as const }, '1': { answer: 'B', confidence: 0.5 } }
  const { answers, confidence, levels } = splitAnswers(stored)
  assert.deepEqual(levels, { '0': 'guess' })
  assert.deepEqual(joinAnswers(answers, confidence, levels), stored)
})
