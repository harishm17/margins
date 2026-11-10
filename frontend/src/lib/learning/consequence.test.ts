import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fadeNote, nextReviewLabel, } from './consequence'

// Wednesday 21 October 2026, 15:00 UTC: 8:00 in Los Angeles.
const NOW = new Date('2026-10-21T15:00:00Z')
const LA = 'America/Los_Angeles'

test('the next review is named by the day, in the student\'s own days', () => {
  assert.equal(nextReviewLabel('2026-10-21T20:00:00Z', NOW, LA), 'Next review today')
  assert.equal(nextReviewLabel('2026-10-22T20:00:00Z', NOW, LA), 'Next review tomorrow')
  assert.equal(nextReviewLabel('2026-10-23T20:00:00Z', NOW, LA), 'Next review Fri')
  assert.equal(nextReviewLabel('2026-10-27T20:00:00Z', NOW, LA), 'Next review Tue')
  // A week or more away it is a date, because a weekday would be ambiguous.
  assert.equal(nextReviewLabel('2026-10-28T20:00:00Z', NOW, LA), 'Next review Oct 28')
  assert.equal(nextReviewLabel('2026-11-04T20:00:00Z', NOW, LA), 'Next review Nov 4')
  // 03:00 UTC on the 22nd is still the 21st in Los Angeles.
  assert.equal(nextReviewLabel('2026-10-22T03:00:00Z', NOW, LA), 'Next review today')
  assert.equal(nextReviewLabel('2026-10-22T03:00:00Z', NOW, 'UTC'), 'Next review tomorrow')
  assert.equal(nextReviewLabel(null, NOW, LA), null)
  assert.equal(nextReviewLabel('nonsense', NOW, LA), null)
})

test('why a ring dropped: mastery fades while a review is late', () => {
  assert.equal(
    fadeNote({ earned: 0.62, shown: 0.44, daysLate: 5 }),
    'Showing 44%, faded from 62% because the review is 5 days late.'
  )
  assert.equal(fadeNote({ earned: 0.62, shown: 0.5, daysLate: 1 }), 'Showing 50%, faded from 62% because the review is 1 day late.')
  // Nothing to explain when it did not fade or the review is not late.
  assert.equal(fadeNote({ earned: 0.62, shown: 0.62, daysLate: 5 }), null)
  assert.equal(fadeNote({ earned: 0.62, shown: 0.4, daysLate: 0 }), null)
  assert.equal(fadeNote({ earned: null, shown: 0.4, daysLate: 2 }), null)
})
