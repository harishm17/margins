import assert from 'node:assert/strict'
import test from 'node:test'
import { isCardClosed, markCardClosed, markCardOpen, saveCardClosed } from './onboarding-state'

test('closing the card is remembered per user', () => {
  markCardClosed('user-a')
  assert.equal(isCardClosed('user-a'), true)
  assert.equal(isCardClosed('user-b'), false)
  markCardOpen('user-a')
  assert.equal(isCardClosed('user-a'), false)
})

test('a failed save is retried once and succeeds', async () => {
  let calls = 0
  const ok = await saveCardClosed(async () => {
    calls++
    if (calls === 1) throw new Error('network')
  })
  assert.equal(ok, true)
  assert.equal(calls, 2)
})
