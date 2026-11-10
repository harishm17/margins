import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  retryAvailableAt,
  retryOpensAt,
  missedQuestions,
  reviewDifficulty,
  type AttemptForReview,
} from './missed'

const q = (text: string, concepts: string[] = []) => ({
  question_type: 'true_false',
  question_text: text,
  correct_answer: true,
  explanation: 'x',
  concepts_tested: concepts,
})

const results = (...correct: boolean[]) =>
  Object.fromEntries(correct.map((isCorrect, index) => [String(index), { isCorrect, pointsEarned: isCorrect ? 1 : 0, pointsPossible: 1 }]))

const attempt = (questions: ReturnType<typeof q>[], ...correct: boolean[]): AttemptForReview => ({ questions, results: results(...correct) })

test('the questions got wrong in the last two attempts are the ones to retry', () => {
  const newest = attempt([q('A'), q('B'), q('C')], true, false, false)
  const older = attempt([q('D'), q('E')], false, true)
  const missed = missedQuestions([newest, older])
  assert.deepEqual(missed.map((item) => item.question.question_text), ['B', 'C', 'D'])
})

test('a question missed first and answered right later is no longer missed', () => {
  const newest = attempt([q('Same question'), q('Other')], true, true)
  const older = attempt([q('same  QUESTION'), q('Third')], false, false)
  assert.deepEqual(missedQuestions([newest, older]).map((item) => item.question.question_text), ['Third'])
  // A question missed twice appears once.
  assert.equal(missedQuestions([attempt([q('Q')], false), attempt([q('Q')], false)]).length, 1)
})

test('a question answered right first and missed later is missed', () => {
  const newest = attempt([q('Q')], false)
  const older = attempt([q('Q')], true)
  assert.deepEqual(missedQuestions([newest, older]).map((item) => item.question.question_text), ['Q'])
})

test('the retry quiz is capped', () => {
  const questions = Array.from({ length: 14 }, (_, index) => q(`Question ${index}`))
  const wrong = attempt(questions, ...questions.map(() => false))
  assert.equal(missedQuestions([wrong]).length, 10)
  assert.equal(missedQuestions([wrong], 3).length, 3)
})

test('review difficulty follows mastery: under 0.4 easy, under 0.75 medium, else hard', () => {
  assert.equal(reviewDifficulty(0), 'easy')
  assert.equal(reviewDifficulty(0.39), 'easy')
  assert.equal(reviewDifficulty(0.4), 'medium')
  assert.equal(reviewDifficulty(0.74), 'medium')
  assert.equal(reviewDifficulty(0.75), 'hard')
  assert.equal(reviewDifficulty(1), 'hard')
  assert.equal(reviewDifficulty(null), 'easy')
  assert.equal(reviewDifficulty(undefined), 'easy')
})

test('the retry is closed until the next local day, and open after', () => {
  const last = new Date('2026-11-04T07:30:00Z') // 23:30 on 3 Nov in Los Angeles
  const zone = 'America/Los_Angeles'
  assert.equal(retryOpensAt(last, zone, new Date('2026-11-04T07:59:00Z'))?.toISOString(), '2026-11-04T08:00:00.000Z')
  assert.equal(retryOpensAt(last, zone, new Date('2026-11-04T08:00:00Z')), null)
  assert.equal(retryOpensAt(null, zone, last), null)
  // The same instant is on another day in another zone.
  assert.equal(retryOpensAt(last, 'UTC', new Date('2026-11-04T12:00:00Z'))?.toISOString(), '2026-11-05T00:00:00.000Z')
  // The next local midnight: 23:30 in Los Angeles on 3 Nov is 07:30 UTC on 4 Nov, so it is 08:00 UTC the same day.
  assert.equal(retryAvailableAt(last, zone).toISOString(), '2026-11-04T08:00:00.000Z')
  // Just after local midnight: still a full day away.
  assert.equal(retryAvailableAt(new Date('2026-11-04T08:05:00Z'), zone).toISOString(), '2026-11-05T08:00:00.000Z')
  // Across the end of a month and a year, and in UTC.
  assert.equal(retryAvailableAt(new Date('2026-12-31T15:00:00Z'), 'UTC').toISOString(), '2027-01-01T00:00:00.000Z')
  // The clocks go back on 1 Nov 2026: that local day is 25 hours long.
  assert.equal(retryAvailableAt(new Date('2026-11-01T12:00:00Z'), zone).toISOString(), '2026-11-02T08:00:00.000Z')
})
