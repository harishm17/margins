import test from 'node:test'
import assert from 'node:assert/strict'
import { STRONG_START_SCORE, strongStartScore } from './record-quiz-attempt'
import type { GradedQuestion } from '@/lib/ai-service/grading'
import type { QuizAnswer } from './quiz-answers'

const graded = (index: number, correct: boolean, possible = 1, earned = correct ? possible : 0): GradedQuestion => ({
  question_index: index,
  question_type: 'true_false',
  points_possible: possible,
  points_earned: earned,
  is_correct: correct,
  feedback: '',
  needs_review: false,
})

test('the strong-start bar is 0.8', () => {
  assert.equal(STRONG_START_SCORE, 0.8)
})

test('right answers count as they are graded', () => {
  const answers: Record<string, QuizAnswer> = { '0': { answer: 'true' }, '1': { answer: 'true', confidence: 0.95, confidenceLevel: 'certain' } }
  assert.equal(strongStartScore([graded(0, true), graded(1, true)], answers), 1)
})

test('guessed right answers do not count', () => {
  const answers: Record<string, QuizAnswer> = {
    '0': { answer: 'true', confidence: 0.5, confidenceLevel: 'guess' },
    '1': { answer: 'true', confidence: 0.5, confidenceLevel: 'unsure' },
    '2': { answer: 'true', confidence: 0.25 },
    '3': { answer: 'true' },
  }
  // Two of the four right answers were guesses (one by level, one by an old stored value): 2 of 4.
  assert.equal(strongStartScore([0, 1, 2, 3].map((i) => graded(i, true)), answers), 0.5)
})

test('a wrong answer and an "I don\'t know" count zero, and partial credit is kept', () => {
  const answers: Record<string, QuizAnswer> = { '0': { answer: 'false' }, '1': { answer: '', idk: true }, '2': { answer: 'text' } }
  assert.equal(strongStartScore([graded(0, false), graded(1, false), graded(2, false, 2, 1)], answers), 0.25)
})

test('a partly right answer marked as a guess counts zero', () => {
  const answers: Record<string, QuizAnswer> = { '0': { answer: 'text', confidence: 0.25, confidenceLevel: 'guess' } }
  assert.equal(strongStartScore([graded(0, true, 2, 2)], answers), 0)
})

test('no points is a score of zero, not a division by zero', () => {
  assert.equal(strongStartScore([], {}), 0)
})
