import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VoiceModelError, parseModelEvent, type ModelEvent } from './ai-turn'
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

})

