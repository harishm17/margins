import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEADLINE_GRACE_MS,
  MAX_ANSWER_LENGTH,
  acceptsAnswers,
  deadlineFor,
  isExpired,
  readStoredAnswers,
  remainingSeconds,
  resolveFinalAnswers,
  sanitizeAnswers,
} from './attempt-timing'

const start = new Date('2026-10-21T10:00:00.000Z')
const deadline = deadlineFor(start, 30)
const at = (secondsAfterStart: number) => new Date(start.getTime() + secondsAfterStart * 1000)

test('the deadline is the server start time plus the duration', () => {
  assert.equal(deadline.toISOString(), '2026-10-21T10:30:00.000Z')
})

test('remaining time counts down from the server start, not from when the page loaded', () => {
  assert.equal(remainingSeconds(deadline, at(0)), 1800)
  assert.equal(remainingSeconds(deadline, at(600)), 1200)
  // A reload 25 minutes in resumes with 5 minutes left.
  assert.equal(remainingSeconds(deadline, at(25 * 60)), 300)
})

test('remaining time rounds partial seconds up and never goes negative', () => {
  assert.equal(remainingSeconds(deadline, new Date(deadline.getTime() - 1)), 1)
  assert.equal(remainingSeconds(deadline, deadline), 0)
  assert.equal(remainingSeconds(deadline, at(31 * 60)), 0)
})

test('answers are accepted until the deadline plus the grace period', () => {
  assert.equal(acceptsAnswers(deadline, at(29 * 60)), true)
  assert.equal(acceptsAnswers(deadline, deadline), true)
  assert.equal(acceptsAnswers(deadline, new Date(deadline.getTime() + DEADLINE_GRACE_MS)), true)
  assert.equal(acceptsAnswers(deadline, new Date(deadline.getTime() + DEADLINE_GRACE_MS + 1)), false)
})

test('isExpired is the opposite of acceptsAnswers', () => {
  assert.equal(isExpired(deadline, at(10)), false)
  assert.equal(isExpired(deadline, at(31 * 60)), true)
})

test('a submit inside the time limit is graded on the answers it carries', () => {
  const result = resolveFinalAnswers({
    saved: { '0': 'A' },
    submitted: { '0': 'B', '1': 'C' },
    deadlineAt: deadline,
    now: at(29 * 60),
  })
  assert.deepEqual(result, { answers: { '0': 'B', '1': 'C' }, usedSubmitted: true })
})

test('a submit after the deadline and grace is graded on what was saved before', () => {
  const result = resolveFinalAnswers({
    saved: { '0': 'A' },
    submitted: { '0': 'changed after time was up' },
    deadlineAt: deadline,
    now: at(40 * 60),
  })
  assert.deepEqual(result, { answers: { '0': 'A' }, usedSubmitted: false })
})

test('an auto-submit without a body is graded on the saved answers', () => {
  const result = resolveFinalAnswers({ saved: { '2': true }, submitted: null, deadlineAt: deadline, now: at(10) })
  assert.deepEqual(result, { answers: { '2': true }, usedSubmitted: false })
})

test('sanitizeAnswers drops unknown questions, odd keys and non-plain values', () => {
  const clean = sanitizeAnswers(
    { '0': 'A', '1': 3.5, '2': true, '3': null, '4': 'out of range', '-1': 'x', abc: 'x', '1e2': 'x' },
    4
  )
  assert.deepEqual(clean, { '0': 'A', '1': 3.5, '2': true, '3': null })
  assert.deepEqual(sanitizeAnswers({ '0': { nested: true }, '1': ['a'] }, 3), {})
  assert.deepEqual(sanitizeAnswers({ '0': Infinity }, 3), {})
})

test('sanitizeAnswers rejects input that is not an object and caps long answers', () => {
  assert.equal(sanitizeAnswers(null, 3), null)
  assert.equal(sanitizeAnswers([1, 2], 3), null)
  assert.equal(sanitizeAnswers('x', 3), null)
  const long = 'x'.repeat(MAX_ANSWER_LENGTH + 500)
  assert.equal(String(sanitizeAnswers({ '0': long }, 1)?.['0']).length, MAX_ANSWER_LENGTH)
})

test('readStoredAnswers tolerates bad stored data', () => {
  assert.deepEqual(readStoredAnswers(null), {})
  assert.deepEqual(readStoredAnswers([1]), {})
  assert.deepEqual(readStoredAnswers({ '0': 'A', '1': { x: 1 } }), { '0': 'A' })
})

test('answers with a confidence are kept, and a confidence out of range is dropped', () => {
  const clean = sanitizeAnswers(
    { '0': { answer: 'B', confidence: 0.75 }, '1': { answer: 'x', confidence: 3 }, '2': { answer: { deep: 1 } }, '3': { confidence: 0.5 } },
    5
  )
  assert.deepEqual(clean, { '0': { answer: 'B', confidence: 0.75 }, '1': 'x' })
  assert.deepEqual(readStoredAnswers({ '0': { answer: 'B', confidence: 0.5 }, '1': 'A' }), { '0': { answer: 'B', confidence: 0.5 }, '1': 'A' })
})

test('an answer keeps a valid confidence level and drops an unknown one', () => {
  const clean = sanitizeAnswers(
    { '0': { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' }, '1': { answer: 'True', confidence: 0.5, confidenceLevel: 'x' } },
    5
  )
  assert.deepEqual(clean, { '0': { answer: 'True', confidence: 0.5, confidenceLevel: 'guess' }, '1': { answer: 'True', confidence: 0.5 } })
})
