import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { INTERRUPTED_NOTE, MAX_HEARD_CHARS, appendUserText, markInterrupted, parseHistory, toStoredHistory, trimHistory, type VoiceBlock, type VoiceMessage } from './history'

const user = (text: string): VoiceMessage => ({ role: 'user', content: text })
const say = (text: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const call = (id: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_next_question', input: {} }] })
const result = (id: string): VoiceMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }] })

describe('parseHistory', () => {
  it('returns [] for anything that is not an array', () => {
    for (const value of [null, undefined, 'x', 5, {}]) assert.deepEqual(parseHistory(value), [])
  })

  it('keeps valid messages and drops malformed ones', () => {
    const parsed = parseHistory([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '  ' },
      { role: 'system', content: 'no' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, 5, { nope: true }] },
      { role: 'assistant', content: [] },
      'junk',
    ])
    assert.deepEqual(parsed, [user('hi'), say('ok')])
  })
})

describe('appendUserText', () => {
  it('adds a user message after an assistant one', () => {
    assert.deepEqual(appendUserText([say('Hello')], 'Hi'), [say('Hello'), user('Hi')])
    assert.deepEqual(appendUserText([], 'Hi'), [user('Hi')])
  })

  it('joins the words to a trailing tool-result message so the results stay first', () => {
    const out = appendUserText([user('start'), call('t1'), result('t1')], 'again')
    assert.equal(out.length, 3)
    assert.deepEqual(out[2].content, [
      { type: 'tool_result', tool_use_id: 't1', content: '{}' },
      { type: 'text', text: 'again' },
    ])
  })
})

describe('trimHistory', () => {
  it('keeps everything under the limit', () => {
    const messages = [user('a'), say('b'), user('c')]
    assert.deepEqual(trimHistory(messages, 30), messages)
  })

  it('starts at a user message, never at an assistant message', () => {
    const messages = [user('1'), say('2'), user('3'), say('4'), user('5'), say('6')]
    assert.deepEqual(trimHistory(messages, 5), [user('3'), say('4'), user('5'), say('6')])
  })

  it('never starts at a tool result: the call it answers would be gone', () => {
    const messages = [user('1'), call('t1'), result('t1'), say('speech'), user('answer'), say('ok')]
    assert.deepEqual(trimHistory(messages, 4), [user('answer'), say('ok')])
  })

  it('can end up empty when nothing in range starts a conversation', () => {
    assert.deepEqual(trimHistory([user('1'), call('t'), result('t'), say('x')], 2), [])
  })
})

describe('toStoredHistory', () => {
  it('drops thinking blocks and the messages left empty', () => {
    const stored = toStoredHistory([
      user('hi'),
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hello' }] },
      user('next'),
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
    ])
    assert.deepEqual(stored, [user('hi'), say('Hello'), user('next')])
  })

  it('keeps tool calls with their results and trims to the limit', () => {
    const many: VoiceMessage[] = []
    for (let i = 0; i < 20; i += 1) many.push(user(`q${i}`), say(`a${i}`))
    many.push(user('last'), call('t9'), result('t9'), say('done'))
    const stored = toStoredHistory(many, 30)
    assert.ok(stored.length <= 30)
    assert.equal(stored[0].role, 'user')
    assert.deepEqual(stored.slice(-4), [user('last'), call('t9'), result('t9'), say('done')])
  })
})

describe('markInterrupted', () => {
  const asked: VoiceMessage[] = [
    { role: 'user', content: 'I think it is a list' },
    { role: 'assistant', content: [{ type: 'text', text: 'Close. What does each bucket hold? And how do you find it?' }] },
  ]

  it('keeps only what the student heard, then a note that they interrupted', () => {
    const marked = markInterrupted(asked, 'Close. What does each bucket hold?')
    assert.deepEqual(marked[1], { role: 'assistant', content: [{ type: 'text', text: `Close. What does each bucket hold? ${INTERRUPTED_NOTE}` }] })
    assert.equal(JSON.stringify(marked).includes('how do you find it'), false)
    assert.equal(marked.length, 2)
  })

  it('a turn with a tool: the text before and after it become one heard text, the tool call and result stay paired', () => {
    const turn: VoiceMessage[] = [
      { role: 'user', content: 'it is a list' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'assess_explanation', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'You have part of it. What about the keys?' }] },
    ]
    const marked = markInterrupted(turn, 'Let me check. You have part')
    assert.equal(marked.length, 4)
    assert.deepEqual(marked[1].content, [{ type: 'tool_use', id: 't1', name: 'assess_explanation', input: {} }])
    assert.deepEqual(marked[3].content, [{ type: 'text', text: `Let me check. You have part ${INTERRUPTED_NOTE}` }])
  })

  it('nothing heard says so, and nothing to mark leaves the messages alone', () => {
    assert.match(String((markInterrupted(asked, '  ')[1].content as VoiceBlock[])[0].text), /before hearing any/)
    const lone: VoiceMessage[] = [{ role: 'user', content: 'hi' }]
    assert.deepEqual(markInterrupted(lone, 'x'), lone)
    assert.deepEqual(markInterrupted([], 'x'), [])
  })

  it('the heard text is cut to a sane length', () => {
    const marked = markInterrupted(asked, 'word '.repeat(2000))
    assert.ok(String((marked[1].content as VoiceBlock[])[0].text).length < MAX_HEARD_CHARS + 100)
  })
})
