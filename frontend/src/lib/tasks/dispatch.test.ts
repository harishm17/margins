import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

// Review-item jobs are sent inline here so the call can be awaited; the module reads these at import.
process.env.DIRECT_INLINE_JOB_TYPES = 'generate_review_items'
process.env.AI_SERVICE_URL = 'http://ai.test'
process.env.AI_INTERNAL_TOKEN = 'token-for-test'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.E2E_HOLD_DIR
  delete process.env.ENABLE_TEST_LOGIN
  delete process.env.NEXTAUTH_URL
})

type Sent = { url: string; headers: Record<string, string>; body: unknown }
function captureFetch(): Sent[] {
  const sent: Sent[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return sent
}

const requests = [{ conceptIds: ['c-merge', 'c-quick'], mode: 'recall', difficulty: 'easy' }]

test('the review-item job is posted to the AI service with the topic and the concepts asked for', async () => {
  const sent = captureFetch()
  const { enqueueReviewItemsJob } = await import('./dispatch')
  await enqueueReviewItemsJob('job-1', 'topic-1', requests)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'http://ai.test/jobs/generate-review-items')
  assert.equal(sent[0].headers['x-ai-internal-token'], 'token-for-test')
  assert.deepEqual(sent[0].body, { jobId: 'job-1', jobType: 'generate_review_items', data: { topicId: 'topic-1', requests } })
})

test('the hold does nothing where the test sign-in is not allowed, even with the variable and the file set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hold-'))
  await writeFile(join(dir, 'generate_review_items.hold'), '')
  process.env.E2E_HOLD_DIR = dir
  const sent = captureFetch()
  const { enqueueReviewItemsJob } = await import('./dispatch')

  // On a real site (not local) the job goes out at once.
  process.env.ENABLE_TEST_LOGIN = 'true'
  process.env.NEXTAUTH_URL = 'https://margins.example.org'
  await enqueueReviewItemsJob('job-site', 'topic-1', requests)
  assert.equal(sent.length, 1)

  // Locally but without the test sign-in on: the same.
  process.env.NEXTAUTH_URL = 'http://localhost:3300'
  delete process.env.ENABLE_TEST_LOGIN
  await enqueueReviewItemsJob('job-off', 'topic-1', requests)
  assert.equal(sent.length, 2)
})

// SEC-L3: what the AI service answers with, or a network error says, can echo a student's text. It is never stored,
// thrown or logged; the job row holds the code and its public text.
const SENTINEL = 'SENTINEL-4f9c1e7a-answer-key'

test('a failed call stores the code and its public text, and neither the row nor the log carries the response body', async () => {
  const logged: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  globalThis.fetch = (async () => new Response(SENTINEL, { status: 500 })) as typeof fetch
  const rows: object[] = []
  try {
    const { enqueueReviewItemsJob, markJobFailed, TaskEnqueueError } = await import('./dispatch')
    const { aiMessage } = await import('@/lib/ai/messages')
    await assert.rejects(enqueueReviewItemsJob('job-s', 'topic-1', requests), (error: Error) => {
      assert.ok(!error.message.includes(SENTINEL))
      return true
    })
    const store = { processingJob: { updateMany: async (args: { data: object }) => void rows.push(args.data) } }
    await markJobFailed({ jobId: 'job-s', jobType: 'generate_review_items', data: {} }, new TaskEnqueueError(SENTINEL, true), store)
    const row = rows[0] as { errorCode: string; errorMessage: string }
    assert.equal(row.errorCode, 'ENQUEUE_FAILED')
    assert.equal(row.errorMessage, aiMessage('ENQUEUE_FAILED').text)
  } finally {
    console.error = realError
  }
  assert.ok(!JSON.stringify(rows).includes(SENTINEL) && !logged.join('\n').includes(SENTINEL))
})

test('a network error that echoes text is logged by class only', async () => {
  const logged: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  globalThis.fetch = (async () => {
    throw new TypeError(SENTINEL)
  }) as typeof fetch
  try {
    const { enqueueReviewItemsJob } = await import('./dispatch')
    await assert.rejects(enqueueReviewItemsJob('job-n', 'topic-1', requests), (error: Error) => !error.message.includes(SENTINEL))
  } finally {
    console.error = realError
  }
  assert.ok(logged.length > 0 && !logged.join('\n').includes(SENTINEL))
})
