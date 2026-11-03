import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRetryableTransactionError, withTransactionRetry } from './transaction-retry'

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } })

test('recognises deadlock, serialization and Prisma transaction conflicts', () => {
  assert.equal(isRetryableTransactionError(deadlock()), true)
  assert.equal(isRetryableTransactionError(Object.assign(new Error('x'), { code: 'P2034' })), true)
  assert.equal(isRetryableTransactionError(Object.assign(new Error('x'), { meta: { code: '40001' } })), true)
  assert.equal(isRetryableTransactionError(new Error('Raw query failed. Code: 40P01')), true)
  assert.equal(isRetryableTransactionError(new Error('unique violation')), false)
  assert.equal(isRetryableTransactionError(null), false)
})

test('retries the whole transaction after a deadlock and returns its result', async () => {
  let calls = 0
  const result = await withTransactionRetry(async () => {
    calls += 1
    if (calls < 3) throw deadlock()
    return 'done'
  })
  assert.equal(result, 'done')
  assert.equal(calls, 3)
})

test('gives up after the bounded number of attempts', async () => {
  let calls = 0
  await assert.rejects(
    withTransactionRetry(async () => {
      calls += 1
      throw deadlock()
    }),
    /deadlock detected/
  )
  assert.equal(calls, 3)
})

test('waits between attempts, longer each time', async () => {
  const stamps: number[] = []
  await assert.rejects(
    withTransactionRetry(
      async () => {
        stamps.push(Date.now())
        throw deadlock()
      },
      3,
      20
    )
  )
  assert.equal(stamps.length, 3)
  // Floors well under the 20 and 40 ms bases, so timer granularity cannot trip them.
  assert.ok(stamps[1] - stamps[0] >= 15)
  assert.ok(stamps[2] - stamps[1] >= 30)
})

test('does not retry other errors', async () => {
  let calls = 0
  await assert.rejects(
    withTransactionRetry(async () => {
      calls += 1
      throw new Error('boom')
    }),
    /boom/
  )
  assert.equal(calls, 1)
})
