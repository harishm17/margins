import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VoiceModelError, parseModelEvent, readModelEvents, type ModelEvent } from './ai-turn'
import type { VoiceMessage } from './history'
import type { VoiceToolResult } from './tools'
import type { VoiceEvent } from './turn-client'
import type { VoiceStreamExtra } from './turn-contract'
import { MAX_MODEL_CALLS, runTurn, type TurnDeps } from './turn-engine'

async function* gen(events: ModelEvent[]): AsyncGenerator<ModelEvent> {
  for (const event of events) yield event
}

const say = (text: string): ModelEvent[] => [
  { type: 'text', delta: text },
  { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text }] },
]

const toolCall = (id: string, name: string, input: Record<string, unknown> = {}): ModelEvent => ({
  type: 'done',
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
})

const ok = (output: Record<string, unknown>, events: VoiceEvent[] = [], extra: Partial<VoiceToolResult> = {}): VoiceToolResult => ({
  output,
  events,
  sessionComplete: false,
  isError: false,
  ...extra,
})

type ToolHandler = (input: Record<string, unknown>) => VoiceToolResult | Promise<VoiceToolResult>

/** A script of model calls (each an array of events, or an Error to throw on open). */
function harness(script: Array<ModelEvent[] | Error>, tools: Record<string, ToolHandler> = {}) {
  const emitted: (VoiceEvent | VoiceStreamExtra)[] = []
  const sent: VoiceMessage[][] = []
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = []
  const deps: TurnDeps = {
    async openModel(messages, callNumber) {
      sent.push(messages)
      const step = script[callNumber - 1]
      if (!step) throw new Error(`unexpected model call ${callNumber}`)
      if (step instanceof Error) throw step
      return gen(step)
    },
    async runTool(name, input) {
      toolCalls.push({ name, input })
      const handler = tools[name]
      if (!handler) throw new Error('no handler')
      return handler(input)
    },
    emit: (event) => emitted.push(event),
    log: () => undefined,
  }
  return { deps, emitted, sent, toolCalls }
}

const start: VoiceMessage[] = [{ role: 'user', content: 'Start' }]

describe('runTurn', () => {
  it('a plain reply streams text and ends with the messages to store', async () => {
    const h = harness([
      [
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'there.' },
        { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text: 'Hello there.' }] },
      ],
    ])
    const outcome = await runTurn(h.deps, start)
    assert.deepEqual(h.emitted, [
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'there.' },
    ])
    assert.equal(outcome.ok, true)
    assert.equal(outcome.text, 'Hello there.')
    assert.equal(outcome.toolsRan, false)
    assert.deepEqual(outcome.messages, [...start, { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] }])
  })

  it('runs a tool, tells the browser, and calls the model again with the result', async () => {
    const question: VoiceEvent = { type: 'question', index: 0, total: 5, text: 'Why?', questionType: 'conceptual' }
    const h = harness([[toolCall('t1', 'get_next_question')], say('Here is your question.')], {
      get_next_question: () => ok({ done: false, question_index: 0 }, [question]),
    })
    const outcome = await runTurn(h.deps, start)

    assert.deepEqual(h.toolCalls, [{ name: 'get_next_question', input: {} }])
    assert.deepEqual(h.emitted.map((e) => e.type), ['question', 'text'])
    assert.equal(h.sent.length, 2)
    const second = h.sent[1]
    assert.equal(second.length, 3)
    assert.deepEqual(second[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ done: false, question_index: 0 }) }],
    })
    assert.equal(outcome.ok && outcome.toolsRan, true)
    assert.equal(outcome.messages.length, 4)
    assert.equal(outcome.text, 'Here is your question.')
  })

  it('marks a tool error as an error result for the model', async () => {
    const h = harness([[toolCall('t1', 'record_answer', { question_index: 0, user_answer: 'x' })], say('Sorry, grading is down.')], {
      record_answer: () => ok({ error: 'Grading is unavailable' }, [], { isError: true }),
    })
    await runTurn(h.deps, start)
    const result = (h.sent[1][2].content as Array<Record<string, unknown>>)[0]
    assert.equal(result.is_error, true)
  })

  it('a tool that throws becomes an error result, not a failed turn', async () => {
    const h = harness([[toolCall('t1', 'get_hint')], say('Let us carry on.')], {
      get_hint: () => {
        throw new Error('db down')
      },
    })
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.ok, true)
    const result = (h.sent[1][2].content as Array<Record<string, unknown>>)[0]
    assert.equal(result.is_error, true)
  })

  it('reports session_complete and says so in the outcome', async () => {
    const h = harness([[toolCall('t1', 'get_next_question')], say('Well done, that was the last one.')], {
      get_next_question: () =>
        ok({ done: true, message: 'Drill complete.' }, [{ type: 'session_complete' }], { sessionComplete: true }),
    })
    const outcome = await runTurn(h.deps, start)
    assert.deepEqual(h.emitted.map((e) => e.type), ['session_complete', 'text'])
    assert.equal(outcome.sessionComplete, true)
  })

  it('answers several tool calls in one message', async () => {
    const two: ModelEvent = {
      type: 'done',
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'get_hint', input: { question_index: 0 } },
        { type: 'tool_use', id: 'b', name: 'get_hint', input: { question_index: 1 } },
      ],
    }
    const h = harness([[two], say('Here you go.')], { get_hint: () => ok({ hint: 'h' }) })
    await runTurn(h.deps, start)
    const results = h.sent[1][2].content as Array<Record<string, unknown>>
    assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b'])
  })

  it('separates the text before and after a tool with a space', async () => {
    const h = harness(
      [
        [
          { type: 'text', delta: 'Nice one.' },
          {
            type: 'done',
            stopReason: 'tool_use',
            content: [
              { type: 'text', text: 'Nice one.' },
              { type: 'tool_use', id: 't', name: 'get_next_question', input: {} },
            ],
          },
        ],
        say('Next question.'),
      ],
      { get_next_question: () => ok({ done: false }) }
    )
    const outcome = await runTurn(h.deps, start)
    assert.deepEqual(h.emitted, [
      { type: 'text', delta: 'Nice one.' },
      { type: 'text', delta: ' ' },
      { type: 'text', delta: 'Next question.' },
    ])
    assert.equal(outcome.text, 'Nice one. Next question.')
  })

  it(`stops after ${MAX_MODEL_CALLS} model calls and still answers the last tool request`, async () => {
    const loop = Array.from({ length: MAX_MODEL_CALLS }, (_, i) => [toolCall(`t${i}`, 'get_hint', { question_index: 0 })])
    const h = harness(loop, { get_hint: () => ok({ hint: 'h' }) })
    const outcome = await runTurn(h.deps, start)
    assert.equal(h.sent.length, MAX_MODEL_CALLS)
    assert.equal(h.toolCalls.length, MAX_MODEL_CALLS)
    assert.equal(outcome.ok, true)
    const last = outcome.messages[outcome.messages.length - 1]
    assert.equal(last.role, 'user')
    assert.equal(outcome.messages[outcome.messages.length - 2].role, 'assistant')
  })

  it('drops a tool call that was cut off by max_tokens', async () => {
    const h = harness([
      [
        { type: 'text', delta: 'Let me' },
        {
          type: 'done',
          stopReason: 'max_tokens',
          content: [
            { type: 'text', text: 'Let me' },
            { type: 'tool_use', id: 't', name: 'get_hint', input: {} },
          ],
        },
      ],
    ])
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.ok, true)
    assert.equal(h.toolCalls.length, 0)
    assert.deepEqual(outcome.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'Let me' }] })
  })

  it('an error before the reply starts is an error event and keeps nothing', async () => {
    const h = harness([new VoiceModelError('LLM_DAILY_BUDGET', 'over budget', false)])
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.toolsRan, false)
    assert.deepEqual(outcome.error, { code: 'LLM_DAILY_BUDGET', retryable: false })
    assert.equal(h.emitted.length, 1)
    const event = h.emitted[0]
    assert.ok(event.type === 'error' && event.message.includes('allowance'))
    // The text the AI service sent is not shown.
    assert.ok(event.type === 'error' && !event.message.includes('over budget'))
  })

  it('an unreachable AI service is VOICE_UNAVAILABLE', async () => {
    const h = harness([new Error('ECONNREFUSED')])
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.error?.code, 'VOICE_UNAVAILABLE')
  })

  it('an error event from the model ends the turn', async () => {
    const h = harness([
      [
        { type: 'text', delta: 'Wel' },
        { type: 'error', code: 'LLM_UNAVAILABLE', message: 'secret detail', retryable: true },
      ],
    ])
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error?.code, 'LLM_UNAVAILABLE')
    assert.equal(outcome.text, 'Wel')
    const last = h.emitted[h.emitted.length - 1]
    assert.ok(last.type === 'error' && !last.message.includes('secret'))
  })

  it('a stream that ends without done is VOICE_INTERRUPTED', async () => {
    const h = harness([[{ type: 'text', delta: 'Hel' }]])
    assert.equal((await runTurn(h.deps, start)).error?.code, 'VOICE_INTERRUPTED')
  })

  it('a failure after a tool ran keeps the conversation up to the tool result', async () => {
    const evaluation: VoiceEvent = { type: 'evaluation', isCorrect: true, score: 1, comment: 'ok', explanation: '' }
    const h = harness(
      [[toolCall('t1', 'record_answer', { question_index: 0, user_answer: 'x' })], new VoiceModelError('LLM_UNAVAILABLE', 'down', true)],
      { record_answer: () => ok({ is_correct: true, score: 1, feedback: { comment: 'ok', explanation: '' } }, [evaluation]) }
    )
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.toolsRan, true)
    assert.equal(outcome.messages.length, 3)
    assert.equal(outcome.messages[2].role, 'user')
    assert.deepEqual(h.emitted.map((e) => e.type), ['evaluation', 'error'])
  })
})

describe('parseModelEvent / readModelEvents', () => {
  it('parses the AI service events', () => {
    assert.deepEqual(parseModelEvent('{"type":"tool_use","id":"t","name":"get_hint","input":{"question_index":1}}'), {
      type: 'tool_use',
      id: 't',
      name: 'get_hint',
      input: { question_index: 1 },
    })
    assert.deepEqual(parseModelEvent('{"type":"done","stop_reason":"tool_use","content":[{"type":"text","text":"x"},5],"usage":{}}'), {
      type: 'done',
      stopReason: 'tool_use',
      content: [{ type: 'text', text: 'x' }],
    })
    assert.equal(parseModelEvent('{"type":"tool_use","name":"x"}'), null)
    assert.equal(parseModelEvent('nope'), null)
  })

  it('reads a stream split anywhere', async () => {
    const encoder = new TextEncoder()
    const lines = '{"type":"text","delta":"Hi"}\n{"type":"done","stop_reason":"end_turn","content":[]}\n'
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines.slice(0, 20)))
        controller.enqueue(encoder.encode(lines.slice(20)))
        controller.close()
      },
    })
    const events: ModelEvent[] = []
    for await (const event of readModelEvents(body)) events.push(event)
    assert.deepEqual(events.map((e) => e.type), ['text', 'done'])
  })
})

describe('runTurn timing (spec 19.10)', () => {
  const clock = (...times: number[]) => {
    let i = 0
    return () => times[Math.min(i++, times.length - 1)]
  }

  it('reports each model call: time to its first token and how long it took, and the time spent in tools', async () => {
    // now() is read at: call 1 start, first event, call 1 end, tool start, tool end, call 2 start, first event, end.
    const h = harness(
      [[{ type: 'tool_use', id: 't1', name: 'record_answer', input: { question_index: 0 } }, toolCall('t1', 'record_answer', { question_index: 0 })], say('Right.')],
      { record_answer: () => ok({ is_correct: true }) }
    )
    h.deps.now = clock(0, 1100, 1300, 1300, 1900, 1900, 2800, 3000)
    const outcome = await runTurn(h.deps, start)
    assert.equal(outcome.calls.length, 2)
    assert.deepEqual(outcome.calls[0], { ttftMs: 1100, totalMs: 1300 })
    assert.deepEqual(outcome.calls[1], { ttftMs: 900, totalMs: 1100 })
    assert.equal(outcome.toolMs, 600)
  })

  it('a call that says nothing has no time to a first token, and the first call can start before the engine was asked', async () => {
    const h = harness([[{ type: 'done', stopReason: 'end_turn', content: [] }]])
    h.deps.now = clock(5400)
    h.deps.callStartedAt = (call) => (call === 1 ? 4000 : undefined)
    const outcome = await runTurn(h.deps, start)
    assert.deepEqual(outcome.calls, [{ ttftMs: null, totalMs: 1400 }])
  })
})
