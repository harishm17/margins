import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PREPARE_MAX_RETRIES,
  PREPARE_RETRY_AFTER_MS,
  prepareConceptsStart,
  startPrepareConcepts,
  type PrepareConceptsDeps,
  type PrepareConceptsState,
} from './prepare-concepts'

const bare: PrepareConceptsState = { confirmedTopicIds: ['t1', 't2'], attempts: [] }
const now = new Date('2026-11-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 60 * 60 * 1000

function fakeDeps(state: PrepareConceptsState, aiReady = true, hasConcepts = false) {
  const queued: string[] = []
  let jobs = 0
  const deps: PrepareConceptsDeps = {
    hasConcepts: async () => hasConcepts,
    state: async () => state,
    aiReady: async () => aiReady,
    // The job dedupe on the target concepts:<projectId>: only the first call creates a job.
    createJob: async () => ({ jobId: `job-${++jobs}`, created: jobs === 1 }),
    enqueue: async (jobId, topicId) => {
      queued.push(`${jobId}:${topicId}`)
    },
  }
  return { deps, queued }
}

test('the chain starts at the first confirmed topic of a course without concepts', () => {
  assert.equal(prepareConceptsStart(bare), 't1')
})

test('it does not start without topics, or while extraction runs or has finished', () => {
  assert.equal(prepareConceptsStart({ ...bare, confirmedTopicIds: [] }, now), null)
  for (const status of ['pending', 'processing', 'completed']) {
    assert.equal(prepareConceptsStart({ ...bare, attempts: [{ status, at: ago(30 * 24 * HOUR) }] }, now), null)
  }
})

test('a failed extraction is tried again once a day', () => {
  const failed = (hoursAgo: number) => ({ ...bare, attempts: [{ status: 'failed', at: ago(hoursAgo * HOUR) }] })
  assert.equal(prepareConceptsStart(failed(23), now), null)
  assert.equal(prepareConceptsStart(failed(24), now), 't1')
  assert.equal(PREPARE_RETRY_AFTER_MS, 24 * HOUR)
})

test('retries are bounded', () => {
  const failures = (n: number) => ({
    ...bare,
    attempts: Array.from({ length: n }, (_, i) => ({ status: 'failed', at: ago((48 + i * 24) * HOUR) })),
  })
  // The first attempt plus PREPARE_MAX_RETRIES retries; then the course waits for its topics to be opened.
  assert.equal(prepareConceptsStart(failures(PREPARE_MAX_RETRIES), now), 't1')
  assert.equal(prepareConceptsStart(failures(PREPARE_MAX_RETRIES + 1), now), null)
})

test('course without concepts starts prepare_concepts once', async () => {
  const { deps, queued } = fakeDeps(bare)
  assert.equal(await startPrepareConcepts('p1', deps), true)
  // A second render of the overview finds the chain's job already running.
  assert.equal(await startPrepareConcepts('p1', deps), false)
  assert.deepEqual(queued, ['job-1:t1'])
})

test('nothing starts while the AI is unavailable or the allowance is used up', async () => {
  const { deps, queued } = fakeDeps(bare, false)
  assert.equal(await startPrepareConcepts('p1', deps), false)
  assert.deepEqual(queued, [])
})
