import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TIMEOUT_MESSAGE,
  nextDelay,
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

describe('nextDelay', () => {
  it('grows by the factor and stops at the cap', () => {
    let delay = 1000
    const seen = [delay]
    for (let i = 0; i < 8; i += 1) {
      delay = nextDelay(delay, 1.5, 10_000)
      seen.push(delay)
    }
    assert.deepEqual(seen.slice(0, 5), [1000, 1500, 2250, 3375, 5063])
    assert.equal(Math.max(...seen), 10_000)
    assert.equal(seen[seen.length - 1], 10_000)
  })
})

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

  it('starts the backoff over when the job reports new progress', async () => {
    const { env, state } = fakeEnv((id, call) => (call < 6 ? processing(id, call * 10) : completed(id)))

    await pollJobUntilDone('job-1', { env })

    assert.deepEqual(state.sleeps, [1000, 1000, 1000, 1000, 1000, 1000])
  })

  it('reports each update and the final job', async () => {
    const { env } = fakeEnv((id, call) => (call < 3 ? processing(id) : completed(id)))
    const seen: string[] = []

    const result = await pollJobUntilDone('job-1', { env, onUpdate: (job) => seen.push(job.status) })

    assert.deepEqual(seen, ['processing', 'processing', 'completed'])
    assert.equal(result.job?.resultData?.ok, true)
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

  it('follows several jobs at once without one cancelling another (one poller per uploaded file)', async () => {
    const finishAfter: Record<string, number> = { a: 2, b: 5, c: 3 }
    const { env, state } = fakeEnv((id, call) => (call >= finishAfter[id] ? completed(id) : processing(id, call)))

    const results = await Promise.all(['a', 'b', 'c'].map((id) => pollJobUntilDone(id, { env })))

    assert.deepEqual(
      results.map((r) => [r.job?.id, r.state]),
      [['a', 'completed'], ['b', 'completed'], ['c', 'completed']]
    )
    assert.equal(state.fetches.filter((f) => f.jobId === 'a').length, 2)
    assert.equal(state.fetches.filter((f) => f.jobId === 'b').length, 5)
  })

  it('aborting one job leaves the others running', async () => {
    const { env } = fakeEnv((id, call) => (call >= 4 ? completed(id) : processing(id, call)))
    const stopA = new AbortController()
    const baseSleep = env.sleep
    let sleeps = 0
    env.sleep = async (ms, signal) => {
      sleeps += 1
      if (sleeps === 2) stopA.abort()
      await baseSleep(ms, signal)
    }

    const [a, b] = await Promise.all([
      pollJobUntilDone('a', { env, signal: stopA.signal }),
      pollJobUntilDone('b', { env }),
    ])

    assert.equal(a.state, 'cancelled')
    assert.equal(b.state, 'completed')
  })
})

it('a queued job at the waiting_for_ai stage is waiting for the AI', async () => {
  const { isWaitingForAi } = await import('./poll-job')
  assert.equal(isWaitingForAi({ status: 'queued', stage: 'waiting_for_ai' }), true)
  assert.equal(isWaitingForAi({ status: 'pending', stage: 'waiting_for_ai' }), true)
  assert.equal(isWaitingForAi({ status: 'processing', stage: 'grading' }), false)
  assert.equal(isWaitingForAi({ status: 'failed', stage: 'waiting_for_ai' }), false)
  assert.equal(isWaitingForAi(null), false)
})
