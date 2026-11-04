import test from 'node:test'
import assert from 'node:assert/strict'
import { joinAnswers, splitAnswers, submitDialogCopy, submitSummary } from './exam-answers'

test('the submit dialog says "all blank" once, and names the empty submit', () => {
  const blank = submitDialogCopy({ total: 10, unanswered: 10, flagged: 2 })
  assert.equal(blank.blank, true)
  assert.equal(blank.title, 'All 10 questions are blank')
  assert.equal(blank.confirmLabel, 'Submit empty exam')
  assert.doesNotMatch(blank.description, /unanswered/)
  const mixed = submitDialogCopy({ total: 10, unanswered: 4, flagged: 0 })
  assert.equal(mixed.blank, false)
  assert.equal(mixed.title, 'Submit your exam?')
  assert.equal(mixed.confirmLabel, 'Submit exam')
  assert.equal(submitDialogCopy({ total: 1, unanswered: 1, flagged: 0 }).title, 'The question is blank')
})

test('answers split into text and confidence, and join back the same', () => {
  const stored = { '0': { answer: 'B', confidence: 0.75 }, '1': 'true', '2': 4 }
  const { answers, confidence } = splitAnswers(stored)
  assert.deepEqual(answers, { '0': 'B', '1': 'true', '2': '4' })
  assert.deepEqual(confidence, { '0': 0.75 })
  assert.deepEqual(joinAnswers(answers, confidence), { '0': { answer: 'B', confidence: 0.75 }, '1': 'true', '2': '4' })
})

test('a confidence given before an answer is kept with an empty answer', () => {
  assert.deepEqual(joinAnswers({}, { '3': 0.95 }), { '3': { answer: '', confidence: 0.95 } })
})

test('the chosen level travels with the confidence and comes back', () => {
  const stored = { '0': { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' as const }, '1': { answer: 'B', confidence: 0.5 } }
  const { answers, confidence, levels } = splitAnswers(stored)
  assert.deepEqual(levels, { '0': 'guess' })
  assert.deepEqual(joinAnswers(answers, confidence, levels), stored)
})

test('the submit prompt says how many questions are unanswered and flagged', () => {
  assert.equal(submitSummary({ total: 8, unanswered: 0, flagged: 0 }), 'You answered all 8 questions. You can’t change your answers after you submit.')
  assert.equal(submitSummary({ total: 1, unanswered: 0, flagged: 0 }), 'You answered the question. You can’t change your answers after you submit.')
  assert.equal(
    submitSummary({ total: 8, unanswered: 1, flagged: 0 }),
    '1 question is unanswered and will score zero. You can’t change your answers after you submit.'
  )
  assert.equal(
    submitSummary({ total: 8, unanswered: 3, flagged: 2 }),
    '3 questions are unanswered and will score zero. 2 are flagged to come back to. You can’t change your answers after you submit.'
  )
  assert.equal(
    submitSummary({ total: 8, unanswered: 0, flagged: 1 }),
    'You answered all 8 questions. 1 is flagged to come back to. You can’t change your answers after you submit.'
  )
})
