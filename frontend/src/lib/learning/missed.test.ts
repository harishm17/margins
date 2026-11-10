import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  focusFromConcepts,
  missedConceptIds,
  retryAvailableAt,
  retryOpensAt,
  missedConcepts,
  missedQuestions,
  pickPrerequisite,
  questionKey,
  questionSetKey,
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

test('only the last two attempts count', () => {
  const missed = missedQuestions([attempt([q('A')], true), attempt([q('B')], true), attempt([q('Old miss')], false)])
  assert.deepEqual(missed, [])
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

test('questions with no text are skipped, and old results stored as plain booleans still count', () => {
  const blank = attempt([q('   ')], false)
  assert.deepEqual(missedQuestions([blank]), [])
  const old: AttemptForReview = { questions: [q('Legacy')], results: { '0': false } }
  assert.equal(missedQuestions([old]).length, 1)
})

test('question keys ignore case and spacing', () => {
  assert.equal(questionKey(q('  What   IS x? ')), 'what is x?')
  assert.equal(questionSetKey([q('B'), q('a')]), questionSetKey([q('A'), q('b')]))
})

test('the concepts of the missed questions are listed once each', () => {
  const missed = missedQuestions([
    attempt([q('A', ['Bayes rule', 'Priors']), q('B', ['bayes rule', ' Likelihood '])], false, false),
  ])
  assert.deepEqual(missedConcepts(missed), ['Bayes rule', 'Priors', 'Likelihood'])
  assert.deepEqual(missedConcepts(missed, 2), ['Bayes rule', 'Priors'])
  assert.deepEqual(missedConcepts([]), [])
})

test('the focus text names the concepts and fits the limit', () => {
  assert.equal(focusFromConcepts(['Bayes rule', 'Priors']), 'Concepts you missed: Bayes rule; Priors')
  assert.equal(focusFromConcepts([]), null)
  const long = Array.from({ length: 30 }, (_, index) => `A fairly long concept name number ${index}`)
  const focus = focusFromConcepts(long) as string
  assert.ok(focus.length <= 280)
  assert.ok(focus.startsWith('Concepts you missed: A fairly long concept name number 0'))
  assert.ok(!focus.endsWith(';'))
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

test('the prerequisite to review from is the weakest one', () => {
  assert.equal(pickPrerequisite([]), null)
  assert.deepEqual(pickPrerequisite([{ id: 'a', mastery: 0.9 }, { id: 'b', mastery: 0.3 }, { id: 'c', mastery: null }]), { id: 'c', mastery: null })
  assert.equal(pickPrerequisite([{ id: 'a', mastery: 0.9 }, { id: 'b', mastery: 0.3 }])?.id, 'b')
})

test('fresh review focuses missed concept ids', () => {
  const withIds = (text: string, ids: unknown) => ({ ...q(text), concept_ids: ids })
  const wrong = attempt(
    [withIds('A', ['c1', 'c2']), withIds('B', ['c2', 'c3']), withIds('C', 'nope') as never, withIds('D', ['c4'])],
    false,
    false,
    false,
    true
  )
  const missed = missedQuestions([wrong])
  assert.deepEqual(missedConceptIds(missed), ['c1', 'c2', 'c3'])
  assert.deepEqual(missedConceptIds(missed, 2), ['c1', 'c2'])
  assert.deepEqual(missedConceptIds([]), [])
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
