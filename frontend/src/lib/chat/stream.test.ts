import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseUsage, relayChatStream, type AnswerRecord, type ChatStorage, type UsageInfo } from './stream'

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
    assert.deepEqual(calls.saved[0].usage, { model: 'claude-opus-5-5', inputTokens: 2000, outputTokens: 100, costUsd: 0.01 })
    assert.deepEqual(calls.failures, [])
  })

  it('still stores the answer when the browser has gone away', async () => {
    const { storage, calls } = fakeStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', delta: 'Hel' }) + '\n'))
        await gate
        controller.enqueue(encoder.encode(JSON.stringify(done) + '\n'))
        controller.close()
      },
    })
    const output = relayChatStream({ head, storage, upstream })
    const reader = output.getReader()
    await reader.read() // thread
    await reader.cancel() // the tab closes
    release()
    // Let the pump finish the stream and the write.
    for (let i = 0; i < 50 && calls.saved.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(calls.saved.length, 1)
    assert.equal(calls.saved[0].usage.costUsd, 0.01)
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
    assert.deepEqual(calls.failures, [{ code: 'LLM_REFUSED', usage: { model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 10, costUsd: 0.006 } }])
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

  it('a broken connection is an interruption too', async () => {
    const { storage, calls } = fakeStorage()
    const events = await readAll(
      relayChatStream({
        head,
        storage,
        log: () => {},
        upstream: upstreamOf([{ type: 'text', delta: 'partial' }], { failAfter: true }),
      })
    )
    assert.equal(events.at(-1)?.code, 'CHAT_INTERRUPTED')
    assert.equal(calls.failures.length, 1)
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

  it('ignores lines it does not understand and anything after the final event', async () => {
    const { storage, calls } = fakeStorage()
    const events = await readAll(
      relayChatStream({
        head: [],
        storage,
        upstream: upstreamOf([{ type: 'mystery' }, { type: 'text', delta: 'a' }, done, { type: 'text', delta: 'late' }]),
      })
    )
    assert.deepEqual(events.map((e) => e.type), ['text', 'done', 'saved'])
    assert.equal(calls.saved.length, 1)
  })
})

describe('parseUsage', () => {
  it('reads the AI service usage and tolerates bad numbers', () => {
    assert.deepEqual(parseUsage({ model: 'm', input_tokens: 10.4, output_tokens: 2, cost_usd: 0.5 }), {
      model: 'm',
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.5,
    })
    assert.deepEqual(parseUsage({ input_tokens: -1, output_tokens: 'x', cost_usd: NaN }), {
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })
    assert.equal(parseUsage(null), null)
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
