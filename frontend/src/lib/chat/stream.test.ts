import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { relayChatStream, type AnswerRecord, type ChatStorage, type UsageInfo } from './stream'

const encoder = new TextEncoder()

function upstreamOf(lines: unknown[], options: { failAfter?: boolean; cutLastNewline?: boolean } = {}) {
  const chunks = lines.map((line) => JSON.stringify(line) + '\n')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (options.failAfter) controller.error(new Error('connection reset'))
      else controller.close()
    },
  })
}

function fakeStorage(overrides: Partial<ChatStorage> = {}) {
  const calls = { saved: [] as AnswerRecord[], failures: [] as { code: string; usage: UsageInfo | null }[] }
  const storage: ChatStorage = {
    async saveAnswer(record) {
      calls.saved.push(record)
      return 'msg-1'
    },
    async recordFailure(code, usage) {
      calls.failures.push({ code, usage })
    },
    ...overrides,
  }
  return { storage, calls }
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

const source = {
  marker: 1,
  chunk_id: 'c1',
  material_id: 'm1',
  filename: 'notes.pdf',
  page_start: 3,
  page_end: 3,
  section: null,
  cited_text: 'quote',
}
const done = {
  type: 'done',
  text: 'Answer.',
  sources: [source],
  marks: [{ offset: 7, marker: 1 }],
  stop_reason: 'end_turn',
  retrieved: 2,
  usage: { model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 100, cost_usd: 0.01 },
}
const head = [
  { type: 'thread', threadId: 't1', title: 'Q', isNew: true },
  { type: 'user_message', id: 'u1' },
]

describe('relayChatStream', () => {
  it('relays events in order, stores the answer with its cost and ends with saved', async () => {
    const { storage, calls } = fakeStorage()
    const events = await readAll(
      relayChatStream({
        head,
        storage,
        upstream: upstreamOf([
          { type: 'retrieved', count: 2 },
          { type: 'text', delta: 'Answer.' },
          { type: 'citation', marker: 1, offset: 7, source },
          done,
        ]),
      })
    )
    assert.deepEqual(events.map((e) => e.type), ['thread', 'user_message', 'retrieved', 'text', 'citation', 'done', 'saved'])
    assert.equal(events.at(-1)?.messageId, 'msg-1')
    assert.equal('usage' in (events[5] as object), false, 'usage is not sent to the browser')
    assert.equal(calls.saved.length, 1)
    assert.equal(calls.saved[0].text, 'Answer.')
    assert.equal(calls.saved[0].sources[0].chunkId, 'c1')
    assert.deepEqual(calls.saved[0].marks, [{ offset: 7, marker: 1 }])
    assert.deepEqual(calls.saved[0].usage, { model: 'claude-opus-5-5', inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 })
    assert.deepEqual(calls.failures, [])
  })

  it('cancels the AI call and removes the question when the browser has gone away', async () => {
    const { storage, calls } = fakeStorage()
    let upstreamCancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', delta: 'Hel' }) + '\n'))
        // Never finishes: only a cancel ends it.
      },
      cancel() {
        upstreamCancelled = true
      },
    })
    const output = relayChatStream({ head, storage, upstream })
    const reader = output.getReader()
    await reader.read() // thread
    await reader.cancel() // the tab closes
    for (let i = 0; i < 50 && calls.failures.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(upstreamCancelled, true)
    assert.equal(calls.saved.length, 0)
    assert.deepEqual(calls.failures.map((failure) => failure.code), ['CHAT_INTERRUPTED'])
  })

  it('records a billed failure with its usage and sends a friendly message', async () => {
    const { storage, calls } = fakeStorage()
    const events = await readAll(
      relayChatStream({
        head,
        storage,
        upstream: upstreamOf([
          { type: 'text', delta: "I can't" },
          {
            type: 'error',
            code: 'LLM_REFUSED',
            message: 'Claude declined the request (category: cyber) request_id=abc',
            retryable: false,
            usage: { model: 'claude-opus-5-5', input_tokens: 1500, output_tokens: 10, cost_usd: 0.006 },
          },
        ]),
      })
    )
    const error = events.at(-1) as Record<string, unknown>
    assert.equal(error.type, 'error')
    assert.equal(error.code, 'LLM_REFUSED')
    assert.doesNotMatch(String(error.message), /request_id|cyber/)
    assert.deepEqual(calls.failures, [{ code: 'LLM_REFUSED', usage: { model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.006 } }])
    assert.equal(calls.saved.length, 0)
  })

  it('an error with no usage is recorded with null so the question can be removed', async () => {
    const { storage, calls } = fakeStorage()
    await readAll(
      relayChatStream({
        head,
        storage,
        upstream: upstreamOf([{ type: 'error', code: 'LLM_UNAVAILABLE', message: 'x', retryable: true, usage: null }]),
      })
    )
    assert.deepEqual(calls.failures, [{ code: 'LLM_UNAVAILABLE', usage: null }])
  })

  it('a stream that ends without done or error is an interruption', async () => {
    const { storage, calls } = fakeStorage()
    const events = await readAll(
      relayChatStream({ head, storage, upstream: upstreamOf([{ type: 'text', delta: 'partial' }]) })
    )
    assert.equal(events.at(-1)?.code, 'CHAT_INTERRUPTED')
    assert.deepEqual(calls.failures, [{ code: 'CHAT_INTERRUPTED', usage: null }])
  })

  it('tells the browser when the answer could not be saved', async () => {
    const { storage } = fakeStorage({
      async saveAnswer() {
        throw new Error('db down')
      },
    })
    const events = await readAll(relayChatStream({ head, storage, log: () => {}, upstream: upstreamOf([done]) }))
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['done', 'error'])
    assert.equal(events.at(-1)?.code, 'CHAT_NOT_SAVED')
  })
})

describe('a failed answer leaves no conversation behind', () => {
  it('tells the browser the question (and a new conversation) was removed', async () => {
    // The reviewer's "failed chats are saved": the server dropped the question and the new
    // thread, but the browser had already listed the thread from the `thread` event and was
    // never told, so the conversation stayed in the list with no answer and no retry.
    const { storage } = fakeStorage({
      async recordFailure() {
        return { discarded: true }
      },
    })
    const events = await readAll(
      relayChatStream({
        head,
        storage,
        upstream: upstreamOf([{ type: 'error', code: 'LLM_CREDIT_EXHAUSTED', message: 'credit balance is too low', retryable: false }]),
      })
    )
    const error = events.at(-1) as Record<string, unknown>
    assert.equal(error.type, 'error')
    assert.equal(error.discarded, true)
    assert.doesNotMatch(String(error.message), /credit|Anthropic|key/i)
  })
})

describe('the Ask hooks', () => {
  it('reads each event, stores and sends what the hook says, and adds events after saved', async () => {
    const { storage, calls } = fakeStorage()
    const seen: string[] = []
    const events = await readAll(
      relayChatStream({
        head,
        storage,
        upstream: upstreamOf([{ type: 'route', intent: 'understand' }, { type: 'retrieved', count: 2 }, { ...done, check_question: { question: 'q', answer: 'secret' } }]),
        hooks: {
          onEvent: (raw) => void seen.push(String(raw.type)),
          onDone: (raw) => ({ tutor: { kept: true }, send: { ...raw, check_question: { question: 'q' } } }),
          afterSaved: async (messageId) => [{ type: 'tutor', messageId }],
        },
      })
    )
    assert.deepEqual(seen, ['route', 'retrieved', 'done'])
    assert.deepEqual(calls.saved[0].tutor, { kept: true })
    const doneEvent = events.find((event) => event.type === 'done') as Record<string, unknown>
    assert.deepEqual(doneEvent.check_question, { question: 'q' })
    assert.equal(JSON.stringify(events).includes('secret'), false)
    assert.deepEqual(events.slice(-2), [{ type: 'saved', messageId: 'msg-1' }, { type: 'tutor', messageId: 'msg-1' }])
  })
})
