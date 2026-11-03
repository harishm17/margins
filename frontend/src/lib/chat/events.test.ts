import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyChatEvent, createLineSplitter, INITIAL_ANSWER, parseChatEvent, type AnswerState } from './events'
import { chatErrorMessage } from './errors'

const sourceJson = (marker: number, citedText = 'quote') => ({
  marker,
  chunk_id: `c${marker}`,
  material_id: 'm1',
  filename: 'notes.pdf',
  page_start: marker + 2,
  page_end: marker + 2,
  section: null,
  cited_text: citedText,
})

function run(lines: unknown[], from: AnswerState = INITIAL_ANSWER): AnswerState {
  return lines.reduce<AnswerState>((state, line) => {
    const event = parseChatEvent(JSON.stringify(line))
    assert.ok(event, `unparsed: ${JSON.stringify(line)}`)
    return applyChatEvent(state, event)
  }, from)
}

describe('parseChatEvent', () => {
  it('ignores junk and unknown events', () => {
    for (const line of ['', 'not json', '5', 'null', '{"type":"mystery"}', '{"type":"text"}', '{"type":"citation","offset":1}']) {
      assert.equal(parseChatEvent(line), null, line)
    }
  })

  it('reads a citation with its source', () => {
    const event = parseChatEvent(JSON.stringify({ type: 'citation', marker: 1, offset: 12, source: sourceJson(1) }))
    assert.ok(event && event.type === 'citation')
    assert.equal(event.offset, 12)
    assert.equal(event.source.pageStart, 3)
  })
})

describe('createLineSplitter', () => {
  it('joins lines split across chunks, including multi-byte characters', () => {
    const splitter = createLineSplitter()
    const bytes = new TextEncoder().encode('{"a":"é"}\n{"b":2}\n{"c":')
    const cut = bytes.indexOf(0xc3) + 1 // between the two bytes of é
    assert.deepEqual(splitter.push(bytes.slice(0, cut)), [])
    assert.deepEqual(splitter.push(bytes.slice(cut)), ['{"a":"é"}', '{"b":2}'])
    assert.deepEqual(splitter.push('3}\n'), ['{"c":3}'])
    assert.deepEqual(splitter.flush(), [])
  })

  it('flush returns a last line with no newline', () => {
    const splitter = createLineSplitter()
    assert.deepEqual(splitter.push('{"x":1}'), [])
    assert.deepEqual(splitter.flush(), ['{"x":1}'])
  })
})

describe('applyChatEvent', () => {
  it('builds the answer from text and citation events', () => {
    const state = run([
      { type: 'retrieved', count: 3 },
      { type: 'text', delta: 'Hashing maps keys.' },
      { type: 'citation', marker: 1, offset: 18, source: sourceJson(1, 'first') },
      { type: 'text', delta: ' More.' },
      { type: 'citation', marker: 1, offset: 24, source: sourceJson(1, 'second') },
      { type: 'citation', marker: 2, offset: 24, source: sourceJson(2) },
    ])
    assert.equal(state.status, 'writing')
    assert.equal(state.text, 'Hashing maps keys. More.')
    assert.equal(state.retrieved, 3)
    assert.deepEqual(state.marks, [
      { offset: 18, marker: 1 },
      { offset: 24, marker: 1 },
      { offset: 24, marker: 2 },
    ])
    assert.deepEqual(state.sources.map((s) => s.marker), [1, 2])
    assert.equal(state.sources[0].citedText, 'first\n\nsecond')
  })

  it('does not duplicate a mark or a quote it already has', () => {
    const state = run([
      { type: 'text', delta: 'x' },
      { type: 'citation', marker: 1, offset: 1, source: sourceJson(1, 'same') },
      { type: 'citation', marker: 1, offset: 1, source: sourceJson(1, 'same') },
    ])
    assert.equal(state.marks.length, 1)
    assert.equal(state.sources[0].citedText, 'same')
  })

  it('a reset clears the answer', () => {
    const state = run([
      { type: 'text', delta: 'old' },
      { type: 'citation', marker: 1, offset: 3, source: sourceJson(1) },
      { type: 'reset' },
      { type: 'text', delta: 'new' },
    ])
    assert.equal(state.text, 'new')
    assert.deepEqual(state.marks, [])
    assert.deepEqual(state.sources, [])
  })

  it('done replaces the streamed state with the final answer', () => {
    const state = run([
      { type: 'text', delta: 'draft' },
      {
        type: 'done',
        text: 'final text',
        sources: [sourceJson(1)],
        marks: [{ offset: 5, marker: 1 }],
        retrieved: 4,
        stop_reason: 'end_turn',
      },
      { type: 'saved', messageId: 'msg-1' },
    ])
    assert.equal(state.status, 'done')
    assert.equal(state.text, 'final text')
    assert.equal(state.sources[0].filename, 'notes.pdf')
    assert.equal(state.messageId, 'msg-1')
  })

  it('an error keeps the partial text and shows the friendly message, not the server text', () => {
    const state = run([
      { type: 'text', delta: 'partial' },
      { type: 'error', code: 'LLM_DAILY_BUDGET', message: 'Daily AI usage limit reached ($3.10 of $3.00)', retryable: false },
    ])
    assert.equal(state.status, 'error')
    assert.equal(state.text, 'partial')
    assert.equal(state.error?.retryable, false)
    assert.match(state.error?.message ?? '', /AI allowance/)
    assert.doesNotMatch(state.error?.message ?? '', /\$3/)
  })
})

describe('chatErrorMessage', () => {
  it('knows the codes the AI service sends', () => {
    for (const code of ['LLM_DAILY_BUDGET', 'LLM_REFUSED', 'LLM_BAD_OUTPUT', 'LLM_UNAVAILABLE', 'RETRIEVAL_FAILED', 'LLM_NOT_CONFIGURED']) {
      assert.notEqual(chatErrorMessage(code).message, chatErrorMessage('SOMETHING_NEW').message, code)
    }
  })

  it('hides unknown detail behind a generic message', () => {
    const info = chatErrorMessage('SOMETHING_NEW')
    assert.equal(info.retryable, true)
    assert.doesNotMatch(info.message, /SOMETHING/)
  })
})

describe('the tutoring events', () => {
  const route = { type: 'route', intent: 'understand', has_attempt: false, wants_answer: false, concepts: ['Hash tables'], concept_ids: ['c1'], broad: false, degraded: false }

  it('reads the route event and keeps it on the answer', () => {
    const state = run([route])
    assert.equal(state.route?.intent, 'understand')
    assert.deepEqual(state.route?.concepts, ['Hash tables'])
    assert.equal(parseChatEvent('{"type":"route","intent":"mystery"}'), null)
  })

  it('progress shows what the buffered reply is doing until text arrives', () => {
    let state = run([route, { type: 'retrieved', count: 3 }, { type: 'progress', stage: 'writing' }])
    assert.equal(state.stage, 'writing')
    state = run([{ type: 'progress', stage: 'checking' }], state)
    assert.equal(state.stage, 'checking')
    assert.equal(state.status, 'searching')
    state = run([{ type: 'text', delta: 'Hi' }], state)
    assert.equal(state.stage, null)
    assert.equal(parseChatEvent('{"type":"progress","stage":"elsewhere"}'), null)
  })

  it('done carries the card without its answer', () => {
    const state = run([
      { type: 'done', text: 'The gap.', sources: [], marks: [], retrieved: 1, stop_reason: 'end_turn', check_question: { question: 'What is a bucket?', concept_name: 'Hash tables' } },
    ])
    assert.deepEqual(state.check, { question: 'What is a bucket?', conceptName: 'Hash tables', grade: null })
    assert.equal(run([{ type: 'done', text: 'x', sources: [], marks: [] }]).check, null)
  })

  it('the tutor event says whether the worked example may be asked for', () => {
    assert.equal(run([{ type: 'tutor', workedAllowed: true }]).workedAllowed, true)
    assert.equal(run([{ type: 'tutor' }]).workedAllowed, false)
  })
})
