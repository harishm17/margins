import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TIMEOUT_MESSAGE,
  pollFailureMessage,
  pollJobUntilDone,
  type JobPollEnv,
} from './poll-job'

type FakeJob = Record<string, unknown>

/** A virtual clock and page: sleeping advances time, nothing really waits. */
function fakeEnv(answer: (jobId: string, call: number) => FakeJob | number | Error) {
  const state = {
    time: 0,
    hidden: false,
    fetches: [] as { jobId: string; at: number }[],
    sleeps: [] as number[],
    visibleWaiters: [] as (() => void)[],
    calls: new Map<string, number>(),
  }

  const env: JobPollEnv = {
    fetchJob: async (jobId) => {
      state.fetches.push({ jobId, at: state.time })
      const call = (state.calls.get(jobId) ?? 0) + 1
      state.calls.set(jobId, call)
      const result = answer(jobId, call)
      if (result instanceof Error) throw result
      if (typeof result === 'number') return new Response('nope', { status: result })
      return new Response(JSON.stringify(result), { status: 200 })
    },
    sleep: async (ms) => {
      state.sleeps.push(ms)
      state.time += ms
    },
    waitUntilVisible: () =>
      new Promise<void>((resolve) => {
        state.visibleWaiters.push(() => {
          state.hidden = false
          resolve()
        })
      }),
    isHidden: () => state.hidden,
    now: () => state.time,
    random: () => 0,
  }
  return { env, state }
}

const processing = (id: string, progress = 10): FakeJob => ({
  id,
  status: 'processing',
  progressPercent: progress,
  stage: 'generating',
})
const completed = (id: string): FakeJob => ({ id, status: 'completed', progressPercent: 100, resultData: { ok: true } })

describe('pollJobUntilDone', () => {
  it('backs off between polls of an unchanged job, up to the cap', async () => {
    const { env, state } = fakeEnv((id, call) => (call < 12 ? processing(id) : completed(id)))

    const result = await pollJobUntilDone('job-1', { env, timeoutMs: 10 * 60_000 })

    assert.equal(result.state, 'completed')
    // The first poll sees new progress, the rest see none: 1 s, then growing, then 10 s.
    assert.equal(state.sleeps[0], 1000)
    assert.ok(state.sleeps[2] > state.sleeps[1])
    assert.equal(Math.max(...state.sleeps), 10_000)
    assert.equal(state.sleeps[state.sleeps.length - 1], 10_000)
  })

  it('returns a failed job with its message', async () => {
    const { env } = fakeEnv((id) => ({ id, status: 'failed', errorMessage: 'Daily limit', errorCode: 'LLM_DAILY_BUDGET' }))

    const result = await pollJobUntilDone('job-1', { env })

    assert.equal(result.state, 'failed')
    assert.equal(result.error, 'Daily limit')
    const message = pollFailureMessage(result, 'fallback')
    assert.match(message, /^You've used today's AI allowance\. It resets (tomorrow )?at /)
    assert.doesNotMatch(message, /Daily limit|\$/)
  })

  it('keeps raw errors of other failures out of the user message', async () => {
    const { env } = fakeEnv((id) => ({ id, status: 'failed', errorMessage: 'asyncpg.exceptions: boom', errorCode: 'X' }))

    const result = await pollJobUntilDone('job-1', { env })

    assert.equal(pollFailureMessage(result, 'Something went wrong'), 'Something went wrong')
  })

  it('stops with a still-working timeout after timeoutMs, and the job is not marked failed', async () => {
    const { env } = fakeEnv((id) => processing(id))

    const result = await pollJobUntilDone('job-1', { env, timeoutMs: 30_000 })

    assert.equal(result.state, 'timeout')
    assert.equal(result.error, TIMEOUT_MESSAGE)
    assert.match(TIMEOUT_MESSAGE, /still running/)
    assert.equal(result.job?.status, 'processing')
    assert.equal(pollFailureMessage(result, 'fallback'), TIMEOUT_MESSAGE)
  })

  it('does not ask while the tab is hidden, asks at once when it is visible, and does not count hidden time', async () => {
    const { env, state } = fakeEnv((id, call) => (call < 3 ? processing(id) : completed(id)))
    let polls = 0
    const originalFetch = env.fetchJob
    env.fetchJob = async (...args) => {
      polls += 1
      if (polls === 1) state.hidden = true // the tab is backgrounded after the first poll
      return originalFetch(...args)
    }

    const running = pollJobUntilDone('job-1', { env, timeoutMs: 60_000 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.fetches.length, 1, 'no request while hidden')
    assert.equal(state.visibleWaiters.length, 1)

    state.time += 60 * 60_000 // an hour in the background
    state.visibleWaiters[0]()
    const result = await running

    assert.equal(result.state, 'completed')
    assert.equal(state.fetches[1].at, 1000 + 60 * 60_000, 'polls immediately after becoming visible')
  })

  it('stops when aborted and says so', async () => {
    const { env } = fakeEnv((id) => processing(id))
    const controller = new AbortController()
    env.sleep = async () => {
      controller.abort()
    }

    const result = await pollJobUntilDone('job-1', { env, signal: controller.signal })

    assert.equal(result.state, 'cancelled')
  })

  it('retries server errors and network errors, but fails on a rejected request', async () => {
    const sequence: (FakeJob | number | Error)[] = [503, new TypeError('network'), 429, completed('job-1')]
    const { env, state } = fakeEnv(() => sequence.shift()!)

    const result = await pollJobUntilDone('job-1', { env })
    assert.equal(result.state, 'completed')
    assert.equal(state.fetches.length, 4)

    const rejected = fakeEnv(() => 404)
    const failed = await pollJobUntilDone('job-1', { env: rejected.env })
    assert.equal(failed.state, 'failed')
    assert.equal(rejected.state.fetches.length, 1)
  })
})
