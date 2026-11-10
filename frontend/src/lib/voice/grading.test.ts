import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHint, toGradableQuestion } from './grading'

const conceptual = {
  question_type: 'conceptual',
  question_text: 'Why does a cache help?',
  key_points: ['Keeps hot data close', 'Cuts latency'],
  sample_answer: 'A cache keeps frequently used data in faster storage.',
  concepts_tested: ['Caching'],
}

test('hints never contain the sample answer or key points', () => {
  const output = JSON.stringify(buildHint(conceptual))
  assert.equal(output.includes('faster storage'), false)
  assert.equal(output.includes('Keeps hot data close'), false)
  assert.equal(output.includes('Cuts latency'), false)
  assert.equal(output.includes('sample_answer'), false)
})

test('choice questions get a type-specific nudge that does not name the option', () => {
  const hint = buildHint({
    question_type: 'multiple_choice',
    question_text: 'Pick',
    correct_answer: 'B',
    options: [{ id: 'B', text: 'secret option' }],
  })
  assert.equal(JSON.stringify(hint).includes('secret option'), false)
  assert.match(hint.hint, /options/)
})

test('a multiple-choice voice question is graded against the correct option text', () => {
  const graded = toGradableQuestion({
    question_type: 'multiple_choice',
    question_text: 'Pick',
    correct_answer: 'b',
    options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'the right one' }],
  })
  assert.equal(graded?.sample_answer, 'B: the right one')
  assert.deepEqual(graded?.key_points, ['the right one'])
})

test('true/false voice questions use True or False as the sample answer', () => {
  const graded = toGradableQuestion({ question_type: 'true_false', question_text: 'q', correct_answer: false })
  assert.equal(graded?.sample_answer, 'False')
})

test('a question with nothing to grade against returns null', () => {
  assert.equal(toGradableQuestion({ question_type: 'conceptual', question_text: 'q' }), null)
})
