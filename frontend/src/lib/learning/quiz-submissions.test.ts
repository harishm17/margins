import test from 'node:test'
import assert from 'node:assert/strict'
import { aiMessage } from '@/lib/ai/messages'
import { describeJobFailure } from '@/lib/jobs/failure-message'
import { toStoredResults } from './quiz-review'
import { ruleGradable, ruleGradableIndexes } from '@/lib/ai-service/grading'
import { mergeRuleResults, partialLine, partialSummary } from './quiz-partial'
import { answersHash, readGrading, waitingState } from './quiz-submissions'

test('a stored quiz is waiting, being graded, or did not finish, by its latest job', () => {
  assert.equal(waitingState({ status: 'pending', stage: 'waiting_for_ai' }), 'waiting')
  assert.equal(waitingState({ status: 'pending', stage: 'grading' }), 'grading')
  assert.equal(waitingState({ status: 'processing', stage: 'grading' }), 'grading')
  // The job's own failure (the wait ran out after 7 days, or it could not start) and no job at all.
  assert.equal(waitingState({ status: 'failed', stage: 'waiting_for_ai' }), 'failed')
  assert.equal(waitingState(undefined), 'failed')
})

test('the same answers hash the same, in any key order, and different answers do not', () => {
  assert.equal(answersHash({ '0': 'A', '2': 'text' }), answersHash({ '2': 'text', '0': 'A' }))
  assert.notEqual(answersHash({ '0': 'A' }), answersHash({ '0': 'B' }))
  assert.notEqual(answersHash({ '0': 'A' }), answersHash({ '0': 'A', '1': 'x' }))
  assert.notEqual(answersHash({ '0': 'A1' }), answersHash({ '0': 'A', '1': '' }))
})

test('only a complete grading is read: no score, no mastery', () => {
  assert.equal(readGrading(null), null)
  assert.equal(readGrading({ graded_questions: [] }), null)
  assert.equal(readGrading({ overall_score: 50 }), null)
  const grading = readGrading({
    graded_questions: [
      { question_index: 0, question_type: 'short_answer', points_possible: 2, points_earned: 1, is_correct: false, feedback: 'Half.', needs_review: false },
    ],
    overall_score: 50,
    earned_points: 1,
    total_points: 2,
  })
  assert.deepEqual({ score: grading?.score, earned: grading?.earned, total: grading?.total }, { score: 50, earned: 1, total: 2 })
  // The stored results are the ones a quiz graded at once keeps.
  assert.deepEqual(toStoredResults(grading!.graded), { '0': { isCorrect: false, pointsEarned: 1, pointsPossible: 2, feedback: 'Half.' } })
})

test('a quiz whose grading ran out its wait says so in the student words, with a way on', () => {
  const text = describeJobFailure('LLM_CREDIT_EXHAUSTED', 'credit balance is too low', 'grade_quiz')
  assert.equal(text, aiMessage('LLM_CREDIT_EXHAUSTED').text)
  assert.match(describeJobFailure(null, null, 'grade_quiz'), /Grade the quiz again/)
  assert.match(describeJobFailure('QUIZ_SUBMISSION_NOT_FOUND', null, 'grade_quiz'), /quiz attempt/)
})

test('multiple choice, true or false and numerical answers are graded by rule; short answers are not', () => {
  assert.equal(ruleGradable({ question_type: 'multiple_choice' }), true)
  assert.equal(ruleGradable({ question_type: 'true_false' }), true)
  assert.equal(ruleGradable({ question_type: 'numerical' }), true)
  assert.equal(ruleGradable({ question_type: 'short_answer' }), false)
  assert.equal(ruleGradable({}), false)
  assert.deepEqual(ruleGradableIndexes([{ question_type: 'short_answer' }, { question_type: 'true_false' }, { question_type: 'numerical' }]), [1, 2])
})

const graded = (index: number, correct: boolean, type = 'true_false', possible = 1) => ({
  question_index: index,
  question_type: type,
  points_possible: possible,
  points_earned: correct ? possible : 0,
  is_correct: correct,
  feedback: '',
  needs_review: false,
})

test('the rule results replace the same questions in the final grading, and the short answers stay as graded', () => {
  const final = [graded(0, false), graded(1, true, 'short_answer', 2), graded(2, true)]
  const rule = [graded(0, true), graded(2, true)]
  const merged = mergeRuleResults(final, rule)
  assert.deepEqual(merged.map((q) => [q.question_index, q.is_correct]), [[0, true], [1, true], [2, true]])
  // Nothing to merge leaves the grading as it was.
  assert.equal(mergeRuleResults(final, null), final)
})

test('the partial summary counts the rule items right and the short answers still waiting', () => {
  assert.deepEqual(partialSummary([graded(0, true), graded(2, false), graded(3, true)], 2), { correct: 2, total: 3, waiting: 2 })
})

test('the partial line says what is graded and what waits, with no overall score', () => {
  assert.equal(
    partialLine({ correct: 6, total: 7, waiting: 3 }),
    "6 of 7 multiple choice right. 3 short answers wait for grading; they'll be marked when the AI is back."
  )
  assert.equal(
    partialLine({ correct: 1, total: 1, waiting: 1 }),
    "1 of 1 multiple choice right. 1 short answer waits for grading; it'll be marked when the AI is back."
  )
})
