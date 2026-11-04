import test from 'node:test'
import assert from 'node:assert/strict'
import { groupEmptyRuns } from './empty-runs'

type Day = { date: string; items: number }
const days = (...items: number[]): Day[] => items.map((count, index) => ({ date: `d${index}`, items: count }))
const empty = (day: Day) => day.items === 0

test('consecutive empty days become one row', () => {
  const rows = groupEmptyRuns(days(2, 0, 0, 0, 1), empty)
  assert.deepEqual(rows.map((row) => (row.kind === 'empty' ? `empty:${row.days.length}` : `day:${row.day.date}`)), ['day:d0', 'empty:3', 'day:d4'])
})

test('a single empty day stays its own row (a lone rest day)', () => {
  const rows = groupEmptyRuns(days(1, 0, 1), empty)
  assert.deepEqual(rows.map((row) => row.kind), ['day', 'day', 'day'])
})

test('at most one empty row sits between days that have something', () => {
  const rows = groupEmptyRuns(days(1, 0, 0, 1, 0, 0, 0, 0, 1), empty)
  for (let index = 1; index < rows.length; index += 1) assert.ok(!(rows[index].kind === 'empty' && rows[index - 1].kind === 'empty'))
  assert.equal(rows.filter((row) => row.kind === 'empty').length, 2)
})

test('a run that ends the list is flushed, and no days gives no rows', () => {
  assert.deepEqual(groupEmptyRuns(days(1, 0, 0), empty).map((row) => row.kind), ['day', 'empty'])
  assert.deepEqual(groupEmptyRuns([], empty), [])
})

test('a day that is shown open breaks a run', () => {
  const rows = groupEmptyRuns(days(0, 0, 0, 0), (day) => day.date !== 'd2')
  assert.deepEqual(rows.map((row) => row.kind), ['empty', 'day', 'day'])
})
