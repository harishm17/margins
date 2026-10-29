import test from 'node:test'
import assert from 'node:assert/strict'
import { markJobFailed, TaskEnqueueError, type TaskPayload } from './dispatch'
import { undeliveredWhere } from './undelivered'

type Row = { id: string; status: string; startedAt: Date | null }
const past = new Date(Date.now() - 60_000)
const payloadFor = (jobId: string) => ({ jobId, jobType: 'x' }) as unknown as TaskPayload

/** Stands in for the one Prisma call markJobFailed makes: applies `where` to in-memory rows. */
async function failJob(row: Row): Promise<boolean> {
  let failed = false
  const store = {
    processingJob: {
      async updateMany({ where }: { where: object; data: object }) {
        const w = where as { id: string; status: string; startedAt: null }
        if (row.id === w.id && row.status === w.status && row.startedAt === w.startedAt) failed = true
      },
    },
  }
  await markJobFailed(payloadFor(row.id), new TaskEnqueueError('boom', true), store)
  return failed
}

test('a dispatch that never arrived fails only a job no handler has touched', async () => {
  assert.equal(await failJob({ id: 'j1', status: 'pending', startedAt: null }), true)
})

test('a job back in pending for its retry is left to the reaper, not failed', async () => {
  assert.equal(await failJob({ id: 'j1', status: 'pending', startedAt: past }), false)
})

test('a job whose worker died, or one already finished, is not failed here', async () => {
  for (const status of ['processing', 'completed', 'failed']) {
    assert.equal(await failJob({ id: 'j1', status, startedAt: past }), false, status)
  }
})

test('markJobFailed filters with the shared rule, the same as the AI service dispatcher', async () => {
  let seen: unknown
  const store = {
    processingJob: {
      async updateMany(args: { where: object; data: object }) {
        seen = args.where
      },
    },
  }
  await markJobFailed(payloadFor('j1'), new TaskEnqueueError('x', false), store)
  assert.deepEqual(seen, undeliveredWhere('j1'))
  // ai-service app/services/dispatch.py mark_undelivered: status = 'pending' AND started_at IS NULL
  assert.deepEqual(seen, { id: 'j1', status: 'pending', startedAt: null })
})
