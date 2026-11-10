import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestionResults, examCalibration, isSureAndWrong, readOverall, summarizeTopics } from './results'

const questions = [
  {
    question_type: 'multiple_choice',
    question_text: 'Pick',
    topic_id: 't1',
    topic_name: 'Stacks',
    points: 2,
    options: [
      { id: 'A', text: 'one' },
      { id: 'B', text: 'two' },
    ],
    correct_answer: 'B',
  },
  {
    question_type: 'short_answer',
    question_text: 'Explain a queue',
    topic_id: 't2',
    topic_name: 'Queues',
    points: 4,
    sample_answer: 'First in, first out.',
    key_points: ['FIFO'],
  },
  {
    question_type: 'numerical',
    question_text: 'How many?',
    topic_id: 't1',
    topic_name: 'Stacks',
    points: 2,
    unit: 'm',
    correct_answer: 9.8,
  },
  { question_type: 'true_false', question_text: 'Is it?', points: 1, correct_answer: true },
]

const grading = {
  overall_score: 37.5,
  earned_points: 3,
  total_points: 8,
  graded_questions: [
    { question_index: 0, points_possible: 2, points_earned: 2, is_correct: true, feedback: 'Correct!' },
    {
      question_index: 1,
      points_possible: 4,
      points_earned: 0,
      is_correct: false,
      needs_review: true,
      feedback: 'This answer could not be graded automatically.',
    },
    { question_index: 2, points_possible: 2, points_earned: 1, is_correct: false, feedback: 'Close.' },
  ],
}

const answers = { '0': 'B', '1': 'LIFO', '2': 9.5 }

test('each question gets its answer, the key, points and feedback', () => {
  const results = buildQuestionResults(questions, grading, answers)
  assert.equal(results.length, 4)
  assert.equal(results[0].studentAnswer, 'B. two')
  assert.equal(results[0].correctAnswer, 'B. two')
  assert.equal(results[0].feedback, 'Correct!')
  assert.equal(results[1].correctAnswer, 'First in, first out.')
  assert.equal(results[1].needsReview, true)
  assert.equal(results[2].studentAnswer, '9.5 m')
  assert.equal(results[2].correctAnswer, '9.8 m')
})

test('an unanswered or ungraded question shows no answer and zero points', () => {
  const results = buildQuestionResults(questions, grading, answers)
  assert.equal(results[3].studentAnswer, null)
  assert.equal(results[3].pointsEarned, 0)
  assert.equal(results[3].points, 1)
  assert.equal(results[3].correctAnswer, 'True')
  assert.equal(results[3].isCorrect, false)
})

test('malformed stored data gives an empty list instead of throwing', () => {
  assert.deepEqual(buildQuestionResults(null, null, null), [])
  assert.equal(buildQuestionResults([{ question_text: 'x' }], 'nonsense', []).length, 1)
})

test('weak topics are sorted weakest first with per-topic points', () => {
  const topics = summarizeTopics(buildQuestionResults(questions, grading, answers))
  assert.deepEqual(
    topics.map((topic) => [topic.topicName, topic.pointsEarned, topic.pointsPossible, topic.percent]),
    [
      ['Queues', 0, 4, 0],
      ['Stacks', 3, 4, 75],
    ]
  )
})

test('readOverall reads the stored score', () => {
  assert.deepEqual(readOverall(grading), { score: 37.5, earned: 3, total: 8 })
  assert.equal(readOverall({}), null)
  assert.equal(readOverall(null), null)
})

test('exam question results carry the file and pages each question is based on', () => {
  const questions = [
    { question_type: 'true_false', question_text: 'a', correct_answer: true, sources: [{ material_id: 'm1', filename: 'a.pdf', page_start: 2, page_end: 2 }] },
    { question_type: 'true_false', question_text: 'b', correct_answer: true },
  ]
  const grading = { graded_questions: [{ question_index: 1, sources: [{ filename: 'b.pdf', page_start: 7 }] }] }
  const results = buildQuestionResults(questions, grading, {})
  assert.deepEqual(results[0].sources, [{ materialId: 'm1', filename: 'a.pdf', pageStart: 2, pageEnd: 2 }])
  assert.deepEqual(results[1].sources, [{ materialId: null, filename: 'b.pdf', pageStart: 7, pageEnd: 7 }])
})

test('object answers show the answer and carry the confidence', () => {
  const qs = [
    { question_type: 'true_false', question_text: 'a', correct_answer: true },
    { question_type: 'true_false', question_text: 'b', correct_answer: true },
    { question_type: 'true_false', question_text: 'c', correct_answer: true },
    { question_type: 'true_false', question_text: 'd', correct_answer: true },
  ]
  const gradedQuestions = [false, true, false, true].map((ok, i) => ({
    question_index: i,
    points_possible: 1,
    points_earned: ok ? 1 : 0,
    is_correct: ok,
  }))
  const results = buildQuestionResults(
    qs,
    { graded_questions: gradedQuestions },
    { '0': { answer: 'false', confidence: 0.95 }, '1': { answer: 'true', confidence: 0.5 }, '2': 'false' }
  )
  assert.equal(results[0].studentAnswer, 'False')
  assert.deepEqual(results.map((r) => r.confidence), [0.95, 0.5, null, null])
  assert.deepEqual(results.map(isSureAndWrong), [true, false, false, false])
  // Question 3 was left blank, so it was not rated; question 2 has no rating.
  assert.deepEqual(examCalibration(results), { rated: 2, sure: 1, sureRight: 0 })
})

test('a blank question that was rated is not rated', () => {
  const qs = [{ question_type: 'true_false', question_text: 'a', correct_answer: true }]
  const grading = { graded_questions: [{ question_index: 0, points_possible: 1, points_earned: 0, is_correct: false }] }
  const results = buildQuestionResults(qs, grading, { '0': { answer: '', confidence: 0.95 } })
  assert.equal(results[0].confidence, null)
  assert.equal(isSureAndWrong(results[0]), false)
  assert.equal(examCalibration(results), null)
})
