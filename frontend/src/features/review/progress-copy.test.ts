import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrationSentence, FOCUS_REASONS, focusReason, isEarlyWeeks, sparklinePath, sparklinePoints, weekLabel, weeklyDescription } from './progress-copy'

const bins = (rows: [number, number][]) =>
  (['guess', 'unsure', 'fairly', 'certain'] as const).map((label, i) => ({ label, n: rows[i][0], accuracy: rows[i][1] }))

const week = (day: string, accuracy: number) => ({ week: day, n: 10, accuracy })

test('the sentence quotes the most confident bin with enough answers, as an average score', () => {
  assert.equal(calibrationSentence(bins([[2, 0.5], [10, 0.6], [8, 0.7], [12, 0.74]])), 'When you are Certain, your average score is 74%.')
  assert.equal(calibrationSentence(bins([[2, 0.5], [10, 0.6], [8, 0.7], [3, 1]])), 'When you are Fairly sure, your average score is 70%.')
  assert.equal(calibrationSentence(bins([[6, 0.33], [1, 1], [0, 0], [0, 0]])), 'When you are guessing, your average score is 33%.')
  assert.equal(calibrationSentence(bins([[4, 1], [4, 1], [4, 1], [4, 1]])), null)
})

test('a week is named by its Monday as written, whatever the zone', () => {
  assert.equal(weekLabel('2026-10-26'), 'Oct 26')
  assert.equal(weekLabel('2026-01-05'), 'Jan 5')
})

test('the chart has a text equivalent that names every week', () => {
  assert.equal(
    weeklyDescription([week('2026-10-19', 0.625), week('2026-10-26', 0.7)]),
    'Average score on first tries, by week: week of Oct 19 63%, week of Oct 26 70%.'
  )
})

test('the plateau reason says only what two failed reviews prove', () => {
  assert.equal(FOCUS_REASONS.plateau, 'Missed on your last two tries.')
})

test('sparkline points sit at their week, higher score higher up', () => {
  const [a, b, c] = sparklinePoints([week('2026-10-05', 0), week('2026-10-12', 0.5), week('2026-10-19', 1)], 100, 40, 4)
  assert.deepEqual([a.x, b.x, c.x], [4, 50, 96])
  assert.deepEqual([a.y, b.y, c.y], [36, 20, 4])
  assert.deepEqual(sparklinePoints([week('2026-10-05', 1)], 100, 40, 4), [{ x: 50, y: 4 }])
})

test('a hidden week leaves a gap in position and in the line', () => {
  // Weeks of Oct 5, 12 and 26: Oct 19 is hidden, so the third point is two steps from the second.
  const weekly = [week('2026-10-05', 0.5), week('2026-10-12', 0.5), week('2026-10-26', 0.5)]
  const points = sparklinePoints(weekly, 100, 40, 0)
  assert.deepEqual(points.map((p) => Math.round(p.x)), [0, 33, 100])
  // The line joins Oct 5 to Oct 12 only; Oct 26 is a dot of its own.
  assert.equal(sparklinePath(weekly, points), 'M0.0 20.0 L33.3 20.0')
  assert.equal(sparklinePath([week('2026-10-05', 0.5)], sparklinePoints([week('2026-10-05', 0.5)], 100, 40, 0)), '')
})

test('a focus idea with a mix-up on record says what it is; without one it keeps the general reason', () => {
  assert.equal(
    focusReason({ reason: 'misconception', misconception: 'Thinks a hash is reversible' }),
    'Your last miss pointed to a specific mix-up: Thinks a hash is reversible'
  )
  assert.equal(focusReason({ reason: 'misconception', misconception: null }), FOCUS_REASONS.misconception)
  assert.equal(focusReason({ reason: 'plateau', misconception: null }), FOCUS_REASONS.plateau)
})

test('the early-weeks line shows through the first four weeks of answers and then goes', () => {
  assert.equal(isEarlyWeeks({ firstWeekStart: null, thisWeek: '2026-10-26' }), false)
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-26', thisWeek: '2026-10-26' }), true)
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-05', thisWeek: '2026-10-26' }), true) // the fourth week
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-05', thisWeek: '2026-11-02' }), false) // the fifth
})
