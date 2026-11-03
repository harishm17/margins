import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidTimeZone, localDateParts, zonedTimeToUtc } from './study-plan-time'
import { resolveTimeZone } from './time-zone'

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

test('zones ahead of UTC and with half-hour offsets', () => {
  assert.equal(at(2026, 10, 21, 9, 'Asia/Kolkata'), '2026-10-21T03:30:00.000Z')
  assert.equal(at(2026, 10, 21, 9, 'Asia/Tokyo'), '2026-10-21T00:00:00.000Z')
  assert.equal(at(2026, 10, 21, 9, 'UTC'), '2026-10-21T09:00:00.000Z')
})

test('midnight of a day in a zone is the start of that day there', () => {
  assert.equal(at(2026, 10, 21, 0, 'America/Los_Angeles'), '2026-10-21T07:00:00.000Z')
})

test('the calendar date of an instant depends on the zone', () => {
  // 03:00 UTC on the 22nd is still the evening of the 21st in Chicago, and already the 22nd in Tokyo.
  const instant = new Date('2026-10-22T03:00:00Z')
  assert.deepEqual(localDateParts(instant, 'America/Chicago'), { year: 2026, month: 10, day: 21 })
  assert.deepEqual(localDateParts(instant, 'Asia/Tokyo'), { year: 2026, month: 10, day: 22 })
})

test('time zone names are validated', () => {
  assert.equal(isValidTimeZone('America/Chicago'), true)
  assert.equal(isValidTimeZone('Mars/Olympus'), false)
  assert.equal(isValidTimeZone(''), false)
})

test('the zone cookie falls back to UTC when it is missing, odd or invalid', () => {
  assert.equal(resolveTimeZone('America/New_York'), 'America/New_York')
  assert.equal(resolveTimeZone('America%2FNew_York'), 'America/New_York')
  assert.equal(resolveTimeZone(undefined), 'UTC')
  assert.equal(resolveTimeZone(''), 'UTC')
  assert.equal(resolveTimeZone('Mars/Olympus'), 'UTC')
  assert.equal(resolveTimeZone('%E0%A4%A'), 'UTC')
  assert.equal(resolveTimeZone('x'.repeat(100)), 'UTC')
})

test('a zone\'s formatter is made once and reused', async () => {
  const { dateFormatter } = await import('./study-plan-time')
  assert.equal(dateFormatter('America/Chicago', 'day'), dateFormatter('America/Chicago', 'day'))
  assert.notEqual(dateFormatter('America/Chicago', 'day'), dateFormatter('America/Chicago', 'clock'))
  assert.notEqual(dateFormatter('America/Chicago', 'day'), dateFormatter('UTC', 'day'))
})
