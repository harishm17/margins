import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidTimeZone, zonedTimeToUtc } from './study-plan-time'

const at = (year: number, month: number, day: number, hour: number, zone: string) =>
  zonedTimeToUtc({ year, month, day }, hour, 0, zone).toISOString()

test('9 am in Chicago in October is 14:00 UTC (daylight time)', () => {
  assert.equal(at(2026, 10, 21, 9, 'America/Chicago'), '2026-10-21T14:00:00.000Z')
})

test('9 am in Chicago after daylight time ends is 15:00 UTC', () => {
  assert.equal(at(2026, 11, 2, 9, 'America/Chicago'), '2026-11-02T15:00:00.000Z')
  // The day the clocks change: 9 am is already standard time.
  assert.equal(at(2026, 11, 1, 9, 'America/Chicago'), '2026-11-01T15:00:00.000Z')
})

test('time zone names are validated', () => {
  assert.equal(isValidTimeZone('America/Chicago'), true)
  assert.equal(isValidTimeZone('Mars/Olympus'), false)
  assert.equal(isValidTimeZone(''), false)
})
