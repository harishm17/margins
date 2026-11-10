import test from 'node:test'
import assert from 'node:assert/strict'
import { allowanceMessage, nextResetUtc, resetPhrase } from './copy'

const noon = new Date('2026-10-20T12:00:00Z')

test('the reset is the next midnight UTC', () => {
  assert.equal(nextResetUtc(noon).toISOString(), '2026-10-21T00:00:00.000Z')
  assert.equal(nextResetUtc(new Date('2026-12-31T10:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z')
})

test('the time is shown in the given time zone', () => {
  assert.equal(allowanceMessage(noon, 'America/Los_Angeles'), "You've used today's AI allowance. It resets at 5:00 PM.")
  assert.equal(allowanceMessage(noon, 'America/Chicago'), "You've used today's AI allowance. It resets at 7:00 PM.")
  // In UTC the reset is on the next calendar day.
  assert.equal(allowanceMessage(noon, 'UTC'), "You've used today's AI allowance. It resets tomorrow at 12:00 AM.")
})

test('a reset on the next calendar day says tomorrow', () => {
  assert.equal(resetPhrase(noon, 'Asia/Kolkata'), 'tomorrow at 5:30 AM')
  assert.equal(resetPhrase(new Date('2026-10-20T00:00:00Z'), 'Pacific/Auckland'), 'tomorrow at 1:00 PM')
  // Late afternoon in California: midnight UTC is still today there.
  assert.equal(resetPhrase(new Date('2026-10-21T23:00:00Z'), 'America/Los_Angeles'), 'at 5:00 PM')
})
