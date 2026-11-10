import test from 'node:test'
import assert from 'node:assert/strict'
import { masteryLabel, masteryLevel, masteryPercent } from './mastery'

test('no mastery row is Not started', () => {
  assert.equal(masteryLevel(null), 'none')
  assert.equal(masteryLevel(undefined), 'none')
  assert.equal(masteryLabel(null), 'Not started')
})

test('level boundaries: below 0.40, 0.40 to 0.79, 0.80 and up', () => {
  assert.equal(masteryLevel(0), 'learning')
  assert.equal(masteryLevel(0.399), 'learning')
  assert.equal(masteryLevel(0.4), 'getting')
  assert.equal(masteryLevel(0.79), 'getting')
  assert.equal(masteryLevel(0.8), 'strong')
  assert.equal(masteryLevel(1), 'strong')
})

test('percent rounds down and is clamped', () => {
  assert.equal(masteryPercent(0.62), 62)
  assert.equal(masteryPercent(0.29), 29)
  assert.equal(masteryPercent(0.799), 79)
  assert.equal(masteryPercent(1.4), 100)
  assert.equal(masteryPercent(-1), 0)
  assert.equal(masteryPercent(null), null)
})
