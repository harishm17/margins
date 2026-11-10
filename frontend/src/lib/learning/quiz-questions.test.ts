import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewAnswer, toPublicQuestion, toPublicQuestions } from './quiz-questions'

const KEY_FIELDS = ['correct_answer', 'sample_answer', 'key_points', 'explanation', 'acceptable_answers']

const full = {
  question_type: 'multiple_choice',
  question_text: 'Pick one',
  options: [{ id: 'A', text: 'x', is_correct: false }, { id: 'B', text: 'y', is_correct: true }],
  correct_answer: 'B',
  sample_answer: 'y',
  key_points: ['why'],
  explanation: 'Because y.',
  acceptable_answers: ['B'],
  tolerance: 0.1,
  points: 2,
  difficulty: 'easy',
  concepts_tested: ['c'],
}

test('public questions carry no answer key', () => {
  const publicQuestion = toPublicQuestion(full) as Record<string, unknown>
  for (const field of KEY_FIELDS) assert.equal(field in publicQuestion, false, field)
  assert.equal('tolerance' in publicQuestion, false)
  assert.deepEqual(publicQuestion.options, [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }])
  assert.equal(publicQuestion.question_text, 'Pick one')
  assert.equal(publicQuestion.points, 2)
  // No key text survives anywhere in the serialised payload.
  const payload = JSON.stringify(toPublicQuestions([full]))
  assert.equal(payload.includes('Because y.'), false)
  assert.equal(payload.includes('is_correct'), false)
})

test('review answers: sample answer for short answers, the key otherwise', () => {
  assert.equal(reviewAnswer({ question_type: 'short_answer', sample_answer: 'A model answer' }), 'A model answer')
  assert.equal(reviewAnswer({ question_type: 'short_answer' }), '')
  assert.equal(reviewAnswer({ question_type: 'true_false', correct_answer: true }), 'True')
  assert.equal(reviewAnswer({ question_type: 'true_false', correct_answer: 'false' }), 'False')
  assert.equal(reviewAnswer({ question_type: 'numerical', correct_answer: 9.8, unit: 'm/s^2' }), '9.8 m/s^2')
  assert.equal(reviewAnswer({ question_type: 'multiple_choice', correct_answer: 'C' }), 'C')
})

test('exam questions keep their topic but not their key points or sample answer', () => {
  const examQuestion = {
    question_type: 'short_answer',
    question_text: 'Explain a stack',
    topic_id: 't1',
    topic_name: 'Stacks',
    points: 5,
    key_points: ['LIFO', 'push and pop'],
    sample_answer: 'A stack is last in, first out.',
    explanation: 'Stacks are LIFO.',
  }
  const publicQuestion = toPublicQuestion(examQuestion) as Record<string, unknown>
  assert.equal(publicQuestion.topic_name, 'Stacks')
  assert.equal(publicQuestion.topic_id, 't1')
  const payload = JSON.stringify(publicQuestion)
  for (const secret of ['LIFO', 'push and pop', 'last in, first out', 'key_points', 'sample_answer']) {
    assert.equal(payload.includes(secret), false, secret)
  }
})

test('sources are not public before a quiz is answered, but reach the review after grading', async () => {
  const { buildReview } = await import('./quiz-review')
  const question = {
    ...full,
    sources: [{ material_id: 'm1', filename: 'bio.pdf', page_start: 3, page_end: 5 }],
  }
  assert.equal('sources' in (toPublicQuestion(question) as Record<string, unknown>), false)
  const [item] = buildReview([question], { '0': { isCorrect: true, pointsEarned: 2, pointsPossible: 2 } })
  assert.deepEqual(item.sources, [{ materialId: 'm1', filename: 'bio.pdf', pageStart: 3, pageEnd: 5 }])
  assert.deepEqual(buildReview([full], {})[0].sources, [])
})

test('"400 probability" is printed as "400", and a real unit stays', () => {
  const dimensionless = { question_type: 'numerical', question_text: 'q', correct_answer: 400, unit: 'probability', points: 1 }
  assert.equal(reviewAnswer(dimensionless), '400')
  assert.equal('unit' in toPublicQuestion(dimensionless), false)
  const speed = { question_type: 'numerical', question_text: 'q', correct_answer: 9.8, unit: 'm/s^2', points: 1 }
  assert.equal(reviewAnswer(speed), '9.8 m/s^2')
  assert.equal(toPublicQuestion(speed).unit, 'm/s^2')
})
