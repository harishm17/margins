import assert from 'node:assert/strict'
import test from 'node:test'
import { markExpectedMissShown, shouldShowExpectedMiss, type MissStorage } from './expected-miss-rules'

function memoryStorage(): MissStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

// Local noon, so the day does not depend on the machine's time zone offset.
const day = (d: number, h = 12) => new Date(2026, 10, d, h, 0, 0)

test('expected miss shows once per surface per day', () => {
  const storage = memoryStorage()
  assert.equal(shouldShowExpectedMiss('practice_miss', day(2), storage), true)
  markExpectedMissShown('practice_miss', day(2), storage)
  assert.equal(shouldShowExpectedMiss('practice_miss', day(2, 20), storage), false)
  // Another surface is not affected.
  assert.equal(shouldShowExpectedMiss('recall_idk', day(2), storage), true)
  // The next local day shows it again.
  assert.equal(shouldShowExpectedMiss('practice_miss', day(3, 0), storage), true)
})

test('expected miss counts the day in local time, not UTC', () => {
  const storage = memoryStorage()
  markExpectedMissShown('recall_gaps', day(2, 23), storage)
  assert.equal(shouldShowExpectedMiss('recall_gaps', day(2, 23), storage), false)
  assert.equal(shouldShowExpectedMiss('recall_gaps', day(3, 0), storage), true)
})

test('expected miss shows on a summary with half missed', () => {
  const storage = memoryStorage()
  assert.equal(shouldShowExpectedMiss('review_summary', day(2), storage, 0.5), true)
  assert.equal(shouldShowExpectedMiss('review_summary', day(2), storage, 1), true)
  assert.equal(shouldShowExpectedMiss('quiz_results', day(2), storage, 0.5), true)
})

test('expected miss hidden on a summary with a third missed', () => {
  const storage = memoryStorage()
  assert.equal(shouldShowExpectedMiss('review_summary', day(2), storage, 1 / 3), false)
  assert.equal(shouldShowExpectedMiss('quiz_results', day(2), storage, 1 / 3), false)
  // A summary without a share is not a reason to show it.
  assert.equal(shouldShowExpectedMiss('review_summary', day(2), storage), false)
  // Nothing was marked as shown by a hidden decision.
  assert.equal(storage.data.size, 0)
})

test('the quiz line follows its own rule: a score under 60 percent', () => {
  const storage = memoryStorage()
  assert.equal(shouldShowExpectedMiss('quiz_results', day(2), storage, 0.41), true)
  assert.equal(shouldShowExpectedMiss('quiz_results', day(2), storage, 0.4), false)
})

test('expected miss survives storage that throws', () => {
  const broken: MissStorage = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  assert.equal(shouldShowExpectedMiss('warmup_results', day(2), broken), true)
  assert.doesNotThrow(() => markExpectedMissShown('warmup_results', day(2), broken))
})
