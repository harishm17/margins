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
