import test from 'node:test'
import assert from 'node:assert/strict'
import { retryDelayMs } from './retry-delay'

test('without Retry-After the delay is the exponential backoff', () => {
  assert.equal(retryDelayMs(1, null), 250)
  assert.equal(retryDelayMs(2, undefined), 500)
  assert.equal(retryDelayMs(3, null, 100), 1100)
})

test('Retry-After wins when it is longer than the backoff', () => {
  assert.equal(retryDelayMs(1, '20'), 20_000)
  assert.equal(retryDelayMs(2, '7'), 7_000)
})

test('junk and non-positive values are ignored; the wait is capped at two minutes', () => {
  assert.equal(retryDelayMs(1, 'soon'), 250)
  assert.equal(retryDelayMs(1, '0'), 250)
  assert.equal(retryDelayMs(1, '-5'), 250)
  assert.equal(retryDelayMs(1, '99999'), 120_000)
})
