import test from 'node:test'
import assert from 'node:assert/strict'
import { isEarlyWeeks, sparklinePath, sparklinePoints } from './progress-copy'

const week = (day: string, accuracy: number) => ({ week: day, n: 10, accuracy })

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

test('the early-weeks line shows through the first four weeks of answers and then goes', () => {
  assert.equal(isEarlyWeeks({ firstWeekStart: null, thisWeek: '2026-10-26' }), false)
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-26', thisWeek: '2026-10-26' }), true)
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-05', thisWeek: '2026-10-26' }), true) // the fourth week
  assert.equal(isEarlyWeeks({ firstWeekStart: '2026-10-05', thisWeek: '2026-11-02' }), false) // the fifth
})
