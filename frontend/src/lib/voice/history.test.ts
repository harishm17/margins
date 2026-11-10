import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FINISH_CUT_OFF_NOTE, INTERRUPTED_NOTE, appendUserText, markInterrupted, parseHistory, trimHistory, type VoiceMessage } from './history'

const user = (text: string): VoiceMessage => ({ role: 'user', content: text })
const say = (text: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const call = (id: string): VoiceMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_next_question', input: {} }] })
const result = (id: string): VoiceMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }] })

describe('parseHistory', () => {

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
  it('starts at a user message, never at an assistant message', () => {
    const messages = [user('1'), say('2'), user('3'), say('4'), user('5'), say('6')]
    assert.deepEqual(trimHistory(messages, 5), [user('3'), say('4'), user('5'), say('6')])
  })

  it('never starts at a tool result: the call it answers would be gone', () => {
    const messages = [user('1'), call('t1'), result('t1'), say('speech'), user('answer'), say('ok')]
    assert.deepEqual(trimHistory(messages, 4), [user('answer'), say('ok')])
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

  it('a reply cut off and finished in a second call is one reply: the heard text is not added to its first part', () => {
    const turn: VoiceMessage[] = [
      { role: 'user', content: 'it is a list' },
      { role: 'assistant', content: [{ type: 'text', text: 'Each bucket holds a li' }] },
      { role: 'user', content: FINISH_CUT_OFF_NOTE },
      { role: 'assistant', content: [{ type: 'text', text: 'st of the keys that landed there. What follows?' }] },
    ]
    assert.deepEqual(markInterrupted(turn, 'Each bucket holds a li st of the keys'), [
      turn[0],
      { role: 'assistant', content: [{ type: 'text', text: `Each bucket holds a li st of the keys ${INTERRUPTED_NOTE}` }] },
    ])
  })

})
