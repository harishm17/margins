import test from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT_GONE, assertAccountExists } from './account-check'

test('an existing account keeps its session', async () => {
  await assertAccountExists('u1', async () => true)
})

test('a deleted account throws, which signs the session out', async () => {
  await assert.rejects(assertAccountExists('u1', async () => false), { message: ACCOUNT_GONE })
})

test('a database error keeps the session', async () => {
  const warnings: string[] = []
  await assertAccountExists(
    'u1',
    async () => {
      throw new Error('connection refused')
    },
    (message) => warnings.push(message)
  )
  assert.equal(warnings.length, 1)
})

test('a token without a user id is left alone', async () => {
  let asked = false
  await assertAccountExists(undefined, async () => {
    asked = true
    return false
  })
  assert.equal(asked, false)
})
