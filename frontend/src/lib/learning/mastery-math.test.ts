import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMasteryFromSignals, intervalFromMastery } from './mastery-math'

const none = { quizScores: [], voiceScores: [], examScores: [] }

test('a quiz-only student reaches the 7-day review interval at 70%', () => {
  const result = computeMasteryFromSignals({ ...none, quizScores: [70, 70], daysSinceLastPractice: 0 })
  assert.ok(Math.abs(result.mastery - 0.7) < 1e-9)
  assert.equal(intervalFromMastery(result.mastery), 7)
})

test('weights are renormalised over the sources present', () => {
  const cases: Array<[string, { quizScores?: number[]; voiceScores?: number[]; examScores?: number[]; practiceScores?: number[] }, number, number]> = [
    ['a quiz-only student with 100% reaches full mastery', { quizScores: [100] }, 1, 0],
    ['a voice-only student is scored on voice alone', { voiceScores: [0.8] }, 0.8, 0],
    // quiz 0.45 and exam 0.25 are present: (0.45 * 1 + 0.25 * 0.5) / 0.7
    ['quiz and exam', { quizScores: [100], examScores: [0.5] }, 0.575 / 0.7, 0],
    // (0.45 * 1 + 0.15 * 0 + 0.25 * 1) / 0.85
    ['quiz, voice and exam alone use the 45/25/15 split', { quizScores: [100], voiceScores: [0], examScores: [1] }, 0.7 / 0.85, 0],
    ['practice alone is scored on practice alone', { practiceScores: [0.6] }, 0.6, 0.6],
    ['quiz and practice renormalise over 0.45 + 0.15', { quizScores: [100], practiceScores: [0] }, 0.45 / 0.6, 0],
    ['practice scores are optional', { quizScores: [50] }, 0.5, 0],
  ]
  for (const [name, signals, mastery, practice] of cases) {
    const result = computeMasteryFromSignals({ ...none, ...signals, daysSinceLastPractice: 0 })
    assert.ok(Math.abs(result.mastery - mastery) < 1e-9, name)
    assert.ok(Math.abs(result.practice - practice) < 1e-9, name)
  }
})

test('no data at all is zero mastery', () => {
  const result = computeMasteryFromSignals({ ...none, daysSinceLastPractice: 30 })
  assert.equal(result.mastery, 0)
})

test('the recency penalty still applies, capped at 0.25', () => {
  const fresh = computeMasteryFromSignals({ ...none, quizScores: [100], daysSinceLastPractice: 0 })
  const stale = computeMasteryFromSignals({ ...none, quizScores: [100], daysSinceLastPractice: 60 })
  assert.equal(fresh.mastery, 1)
  assert.ok(Math.abs(stale.mastery - 0.75) < 1e-9)
})

test('scores outside the range are clamped', () => {
  const result = computeMasteryFromSignals({ ...none, quizScores: [250], daysSinceLastPractice: 0 })
  assert.equal(result.mastery, 1)
})

import { masteryFromHistory, newestPerTopic } from './mastery-math'

test('newestPerTopic keeps the first rows of each topic and skips rows with no topic', () => {
  const rows = [
    { topicId: 'a', n: 1 },
    { topicId: 'b', n: 2 },
    { topicId: null, n: 3 },
    { topicId: 'a', n: 4 },
    { topicId: 'a', n: 5 },
  ]
  const grouped = newestPerTopic(rows, 2)
  assert.deepEqual(grouped.get('a')?.map((row) => row.n), [1, 4])
  assert.deepEqual(grouped.get('b')?.map((row) => row.n), [2])
  assert.equal(grouped.size, 2)
})

test('masteryFromHistory matches computeMasteryFromSignals on the same results', () => {
  const now = Date.parse('2026-10-21T00:00:00Z')
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000)
  const result = masteryFromHistory({
    quiz: [{ score: 80, at: daysAgo(2) }, { score: 60, at: daysAgo(6) }],
    voice: [{ score: 0.5, at: daysAgo(4) }],
    exam: [],
    now,
  })
  const expected = computeMasteryFromSignals({
    quizScores: [80, 60],
    voiceScores: [0.5],
    examScores: [],
    daysSinceLastPractice: 2,
  })
  assert.deepEqual(result, expected)
  // Practice counts, and its date counts as practice.
  const withPractice = masteryFromHistory({
    quiz: [{ score: 100, at: daysAgo(10) }],
    voice: [],
    exam: [],
    practice: [{ score: 0.5, at: daysAgo(1) }],
    now,
  })
  const expectedWithPractice = computeMasteryFromSignals({
    quizScores: [100],
    voiceScores: [],
    examScores: [],
    practiceScores: [0.5],
    daysSinceLastPractice: 1,
  })
  assert.deepEqual(withPractice, expectedWithPractice)
})

test('masteryFromHistory treats a topic with no results as 30 days idle', () => {
  const result = masteryFromHistory({ quiz: [], voice: [], exam: [], now: Date.now() })
  assert.equal(result.mastery, 0)
  assert.ok(Math.abs(result.recencyPenalty - 0.25) < 1e-9)
})

import { DECAY_FLOOR, displayMastery } from './mastery-math'

test('all four sources use the 45/25/15/15 split', () => {
  const result = computeMasteryFromSignals({
    quizScores: [100],
    examScores: [0],
    voiceScores: [1],
    practiceScores: [0],
    daysSinceLastPractice: 0,
  })
  assert.ok(Math.abs(result.mastery - 0.6) < 1e-9)
})

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-21T12:00:00Z')

test('displayed mastery is the stored mastery until the review is due', () => {
  assert.equal(displayMastery(0.8, { dueAt: new Date(NOW + DAY), intervalDays: 7 }, NOW), 0.8)
  assert.equal(displayMastery(0.8, { dueAt: new Date(NOW), intervalDays: 7 }, NOW), 0.8)
})

test('displayed mastery fades with 0.5^(overdue / (2 * interval))', () => {
  // 7-day interval, 7 days overdue: 0.5^(7/14) = 0.7071
  const shown = displayMastery(0.8, { dueAt: new Date(NOW - 7 * DAY), intervalDays: 7 }, NOW) as number
  assert.ok(Math.abs(shown - 0.8 * Math.pow(0.5, 0.5)) < 1e-9)
  // 1-day interval, 1 day overdue: 0.5^(1/2)
  const quick = displayMastery(1, { dueAt: new Date(NOW - DAY), intervalDays: 1 }, NOW) as number
  assert.ok(Math.abs(quick - Math.SQRT1_2) < 1e-9)
})

test('displayed mastery never falls below half of the stored mastery', () => {
  const far = displayMastery(0.8, { dueAt: new Date(NOW - 365 * DAY), intervalDays: 3 }, NOW) as number
  assert.ok(Math.abs(far - 0.8 * DECAY_FLOOR) < 1e-12)
  // The floor is reached at twice the interval.
  const atFloor = displayMastery(0.6, { dueAt: new Date(NOW - 6 * DAY), intervalDays: 3 }, NOW) as number
  assert.ok(Math.abs(atFloor - 0.3) < 1e-9)
})

test('displayed mastery keeps no-signal, no-schedule and bad inputs as they are', () => {
  assert.equal(displayMastery(null, { dueAt: new Date(NOW - DAY), intervalDays: 1 }, NOW), null)
  assert.equal(displayMastery(undefined, null, NOW), null)
  assert.equal(displayMastery(0.7, null, NOW), 0.7)
  assert.equal(displayMastery(0.7, { dueAt: null, intervalDays: 3 }, NOW), 0.7)
  assert.equal(displayMastery(0.7, { dueAt: 'not a date', intervalDays: 3 }, NOW), 0.7)
  // A zero or missing interval counts as one day, so the result is finite.
  const shown = displayMastery(0.7, { dueAt: new Date(NOW - DAY), intervalDays: 0 }, NOW) as number
  assert.ok(Number.isFinite(shown) && shown < 0.7)
})

test('displayed mastery accepts ISO strings and accepts a Date as the clock', () => {
  const iso = new Date(NOW - 2 * DAY).toISOString()
  assert.equal(displayMastery(0.9, { dueAt: iso, intervalDays: 1 }, new Date(NOW)), displayMastery(0.9, { dueAt: iso, intervalDays: 1 }, NOW))
})
