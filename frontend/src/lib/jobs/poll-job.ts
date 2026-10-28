/**
 * Poll one processing job until it finishes.
 *
 * - Exponential backoff from 1 s to a 10 s cap; a stage or status change starts it over.
 * - No requests while the tab is hidden; polling resumes at once when it is visible again.
 *   Hidden time does not count towards the timeout.
 * - After `timeoutMs` of visible time it gives up with state 'timeout'. The job itself is
 *   still running; the message says so.
 *
 * Everything the poller touches (fetch, timers, page visibility) goes through `JobPollEnv`
 * so the logic runs under plain Node in tests. The React hook is in hooks/useJobPolling.ts.
 */

import { allowanceMessage } from '@/lib/budget/copy'

export type NormalizedJobState = 'queued' | 'processing' | 'completed' | 'failed'

export type NormalizedJob = {
  id: string
  jobType?: string
  status: NormalizedJobState
  progressPercent: number
  stage?: string | null
  errorMessage?: string | null
  errorCode?: string | null
  retryable?: boolean
  /** Attempts made so far. A queued job with attempts made is waiting for its retry. */
  attemptCount?: number
  resultData?: Record<string, unknown> | null
  raw: Record<string, unknown>
}

export type PollResult = {
  state: 'completed' | 'failed' | 'timeout' | 'cancelled'
  job?: NormalizedJob
  error?: string
}

export type PollOptions = {
  timeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
  signal?: AbortSignal
  onUpdate?: (job: NormalizedJob) => void
  env?: JobPollEnv
}

export type JobPollEnv = {
  fetchJob: (jobId: string, signal?: AbortSignal) => Promise<Response>
  /** Resolves after `ms`, or as soon as the signal aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Resolves when the page is visible again (or the signal aborts). */
  waitUntilVisible: (signal?: AbortSignal) => Promise<void>
  isHidden: () => boolean
  now: () => number
  random: () => number
}

export const TIMEOUT_MESSAGE =
  'This is taking longer than expected. It is still running in the background, so check back in a few minutes.'

export const DEFAULT_POLL_TIMEOUT_MS = 120_000

export const normalizeStatus = (value: unknown): NormalizedJobState => {
  const status = String(value || '').toLowerCase()
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'processing') return 'processing'
  return 'queued'
}

export const normalizeJob = (data: Record<string, unknown>): NormalizedJob => ({
  id: String(data.id || ''),
  jobType: typeof data.jobType === 'string' ? data.jobType : undefined,
  status: normalizeStatus(data.status),
  progressPercent: Number(data.progressPercent || 0),
  stage: data.stage ? String(data.stage) : null,
  errorMessage: data.errorMessage ? String(data.errorMessage) : null,
  errorCode: data.errorCode ? String(data.errorCode) : null,
  retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
  attemptCount: typeof data.attemptCount === 'number' ? data.attemptCount : undefined,
  resultData:
    data.resultData && typeof data.resultData === 'object' && !Array.isArray(data.resultData)
      ? (data.resultData as Record<string, unknown>)
      : null,
  raw: data,
})

/** The delay after `current`, capped. */
export const nextDelay = (current: number, factor: number, maxDelayMs: number): number =>
  Math.min(Math.round(current * factor), maxDelayMs)

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

const waitUntilVisible = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted || !document.hidden) return resolve()
    function done() {
      document.removeEventListener('visibilitychange', onChange)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    function onChange() {
      if (!document.hidden) done()
    }
    document.addEventListener('visibilitychange', onChange)
    signal?.addEventListener('abort', done, { once: true })
  })

export const browserEnv: JobPollEnv = {
  fetchJob: (jobId, signal) => fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal }),
  sleep: abortableSleep,
  waitUntilVisible,
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  now: () => Date.now(),
  random: () => Math.random(),
}

export async function pollJobUntilDone(jobId: string, options: PollOptions = {}): Promise<PollResult> {
  const {
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    initialDelayMs = 1_000,
    maxDelayMs = 10_000,
    backoffFactor = 1.5,
    signal,
    onUpdate,
    env = browserEnv,
  } = options

  let delayMs = initialDelayMs
  let startedAt = env.now()
  let lastJob: NormalizedJob | undefined
  let lastProgressKey = ''
  let fetchNow = false

  const cancelled = (): PollResult => ({ state: 'cancelled', job: lastJob, error: 'Polling cancelled' })

  while (true) {
    if (signal?.aborted) return cancelled()

    if (env.isHidden()) {
      const hiddenAt = env.now()
      await env.waitUntilVisible(signal)
      // Time in the background is not time spent waiting.
      startedAt += env.now() - hiddenAt
      delayMs = initialDelayMs
      fetchNow = true
      continue
    }

    if (!fetchNow) {
      const jitter = Math.floor(env.random() * Math.min(500, delayMs * 0.15))
      await env.sleep(delayMs + jitter, signal)
      if (signal?.aborted) return cancelled()
      if (env.isHidden()) continue
    }
    fetchNow = false

    if (env.now() - startedAt > timeoutMs) {
      return { state: 'timeout', job: lastJob, error: TIMEOUT_MESSAGE }
    }

    try {
      const response = await env.fetchJob(jobId, signal)
      if (!response.ok) {
        // A rejected request (not signed in, no such job) will not get better; a server
        // error or rate limit might.
        if (response.status >= 500 || response.status === 429) {
          delayMs = nextDelay(delayMs, backoffFactor, maxDelayMs)
          continue
        }
        const text = await response.text().catch(() => '')
        return {
          state: 'failed',
          job: lastJob,
          error: text || `Failed to fetch job status (${response.status})`,
        }
      }

      const job = normalizeJob((await response.json()) as Record<string, unknown>)
      lastJob = job
      onUpdate?.(job)

      if (job.status === 'completed') return { state: 'completed', job }
      if (job.status === 'failed') {
        return { state: 'failed', job, error: job.errorMessage || 'Job failed' }
      }

      const progressKey = `${job.status}:${job.stage ?? ''}:${job.progressPercent}`
      delayMs =
        progressKey !== lastProgressKey
          ? initialDelayMs
          : nextDelay(delayMs, backoffFactor, maxDelayMs)
      lastProgressKey = progressKey
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return cancelled()
      }
      // Network blip: back off and try again until the timeout.
      delayMs = nextDelay(delayMs, backoffFactor, maxDelayMs)
    }
  }
}

/**
 * The message to show for a poll that did not complete. The daily-budget refusal (with the reset
 * time in the student's time zone, never the job's own message with its figures) and the timeout
 * carry text written for the user; anything else gets the caller's fallback, so raw server errors
 * stay out of the page.
 */
export function pollFailureMessage(result: PollResult, fallback: string): string {
  if (result.state === 'timeout') return TIMEOUT_MESSAGE
  if (result.job?.errorCode === 'LLM_DAILY_BUDGET') return allowanceMessage()
  return fallback
}

export type ActiveJobFilter = { projectId?: string; jobTypes?: string[] }

/** Jobs of the signed-in user that are still pending or processing (resume after a refresh). */
export async function fetchActiveJobs(
  filter: ActiveJobFilter = {},
  signal?: AbortSignal
): Promise<NormalizedJob[]> {
  const query = new URLSearchParams({ active: '1' })
  if (filter.projectId) query.set('projectId', filter.projectId)
  if (filter.jobTypes?.length) query.set('types', filter.jobTypes.join(','))
  const response = await fetch(`/api/jobs?${query.toString()}`, { signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { jobs?: Record<string, unknown>[] }
  return (payload.jobs ?? []).map(normalizeJob)
}
