import assert from 'node:assert/strict'
import test from 'node:test'
import { missedScope } from './exam-practice'

const questions = [
  { question_text: 'a', topic_id: 't1', concept_ids: ['c1', 'c2'] },
  { question_text: 'b', topic_id: 't2', concept_ids: ['c2'] },
  { question_text: 'c', topic_id: 't3' },
  { question_text: 'd', topic_id: 't4', concept_ids: ['c9'] },
]
const grading = (flags: [boolean, boolean?][]) => ({
  graded_questions: flags.map(([isCorrect, needsReview], question_index) => ({ question_index, is_correct: isCorrect, needs_review: needsReview === true })),
})

test('the concepts and topics of the missed questions, each once', () => {
  const scope = missedScope(questions, grading([[false], [false], [true], [true]]))
  assert.deepEqual(scope, { missed: 2, conceptIds: ['c1', 'c2'], topicIds: ['t1', 't2'] })
})

test('a question the grader could not grade is not missed', () => {
  const scope = missedScope(questions, grading([[true], [false, true], [true], [true]]))
  assert.deepEqual(scope, { missed: 0, conceptIds: [], topicIds: [] })
})

test('a missed question that names no concept still gives its topic', () => {
  const scope = missedScope(questions, grading([[true], [true], [false], [true]]))
  assert.deepEqual(scope, { missed: 1, conceptIds: [], topicIds: ['t3'] })
})

test('a concept the grader blamed for a short answer is added', () => {
  const graded = { graded_questions: [{ question_index: 2, is_correct: false, needs_review: false, blamed_concept_id: 'c7' }] }
  assert.deepEqual(missedScope(questions, graded).conceptIds, ['c7'])
})

test('a question the grader did not return is not counted, and nothing readable gives nothing', () => {
  assert.equal(missedScope(questions, grading([[false]])).missed, 1)
  assert.deepEqual(missedScope(null, null), { missed: 0, conceptIds: [], topicIds: [] })
})
