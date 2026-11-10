import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STEPPED_HIGH, STEPPED_LOW, toStoredHistory, trimHistorySteps, type VoiceMessage } from './history'

const user = (text: string): VoiceMessage => ({ role: 'user', content: text })
const say = (text: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const call = (id: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_next_question', input: {} }] })
const result = (id: string): VoiceMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }] })

/** n exchanges of student words and a reply: 2n messages. */
const exchanges = (n: number): VoiceMessage[] => Array.from({ length: n }, (_, i) => [user(`q${i}`), say(`a${i}`)]).flat()

describe('trimHistorySteps (M6)', () => {
  it('lets the history grow to the high mark without touching it', () => {
    const messages = exchanges(STEPPED_HIGH / 2)
    assert.equal(messages.length, STEPPED_HIGH)
    assert.deepEqual(trimHistorySteps(messages), messages)
  })

  it('cuts back to about the low mark once it passes the high mark, so the start stays put between cuts', () => {
    const over = exchanges(STEPPED_HIGH / 2 + 1)
    const cut = trimHistorySteps(over)
    assert.equal(cut.length, STEPPED_LOW)
    assert.deepEqual(cut, over.slice(over.length - STEPPED_LOW))
    // Growing again from there does not move the first message until the next cut.
    const grown = [...cut, ...exchanges(5)]
    assert.deepEqual(trimHistorySteps(grown)[0], cut[0])
  })

  it('never starts on a tool result or splits a tool call from its result', () => {
    const messages: VoiceMessage[] = [...exchanges(STEPPED_HIGH / 2 - 5)]
    for (let i = 0; i < 8; i += 1) messages.push(user(`t${i}`), call(`c${i}`), result(`c${i}`), say(`s${i}`))
    const cut = trimHistorySteps(messages)
    assert.ok(cut.length <= STEPPED_LOW)
    assert.equal(cut[0].role, 'user')
    assert.ok(typeof cut[0].content === 'string' || !cut[0].content.some((b) => b.type === 'tool_result'))
    const ids = new Set<string>()
    for (const m of cut) {
      if (typeof m.content === 'string') continue
      for (const b of m.content) {
        if (b.type === 'tool_use') ids.add(b.id as string)
        if (b.type === 'tool_result') assert.ok(ids.has(b.tool_use_id as string), 'tool result without its call')
      }
    }
  })
})

describe('toStoredHistory', () => {
  it('v1 still slides a window of 30', () => {
    assert.equal(toStoredHistory(exchanges(25), 30, false).length, 30)
  })

  it('v2 keeps up to 40 and then steps back to 20', () => {
    assert.equal(toStoredHistory(exchanges(18), 30, true).length, 36)
    assert.equal(toStoredHistory(exchanges(21), 30, true).length, STEPPED_LOW)
  })
})
