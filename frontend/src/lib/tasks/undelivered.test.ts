import test from 'node:test'
import assert from 'node:assert/strict'
import { canMarkUndelivered, undeliveredWhere } from './undelivered'

type Row = { status: string; startedAt: Date | null; leaseUntil?: Date | null }
const past = new Date(Date.now() - 60_000)

test('a dispatch that never arrived fails only a job no handler has touched', () => {
  assert.equal(canMarkUndelivered({ status: 'pending', startedAt: null }), true)
})

test('a job back in pending for its retry is left to the reaper, not failed', () => {
  // It ran (one transient failure) and has attempts left: failing it here would lose the retry.
  assert.equal(canMarkUndelivered({ status: 'pending', startedAt: past }), false)
})

test('a job whose worker died is the reaper\'s too, and so is everything finished', () => {
  const rows: Row[] = [
    { status: 'processing', startedAt: past, leaseUntil: past },
    { status: 'processing', startedAt: past, leaseUntil: null },
    { status: 'completed', startedAt: past },
    { status: 'failed', startedAt: past },
  ]
  for (const row of rows) assert.equal(canMarkUndelivered(row), false, JSON.stringify(row))
})

test('the database filter is the same rule as the AI service dispatcher', () => {
  // ai-service app/services/cloud_tasks.py mark_undelivered: status = 'pending' AND started_at IS NULL
  assert.deepEqual(undeliveredWhere('j1'), { id: 'j1', status: 'pending', startedAt: null })
})
