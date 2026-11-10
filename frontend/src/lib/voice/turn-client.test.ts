import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createSentenceChunker,
  parseVoiceEvent,
  readVoiceEvents,
  type VoiceEvent,
} from './turn-client'

describe('parseVoiceEvent', () => {
  it('ignores junk and unknown or malformed events', () => {
    for (const line of [
      '',
      'not json',
      '5',
      'null',
      '[]',
      '{"type":"mystery"}',
      '{"type":"text"}',
      '{"type":"question","index":"1","text":"q"}',
      '{"type":"evaluation","score":1}',
      '{"type":"hint"}',
    ]) {
      assert.equal(parseVoiceEvent(line), null, line)
    }
  })

  it('parses a question with options, dropping empty ones', () => {
    const event = parseVoiceEvent(
      JSON.stringify({
        type: 'question',
        index: 2,
        total: 10,
        text: 'Which one?',
        questionType: 'multiple_choice',
        options: [{ id: 'A', text: 'First' }, { id: '', text: 'x' }, { id: 'B', text: 'Second' }],
      })
    )
    assert.deepEqual(event, {
      type: 'question',
      index: 2,
      total: 10,
      text: 'Which one?',
      questionType: 'multiple_choice',
      options: [{ id: 'A', text: 'First' }, { id: 'B', text: 'Second' }],
    })
  })

  it('parses an evaluation, keeping ungraded only when true', () => {
    assert.deepEqual(
      parseVoiceEvent('{"type":"evaluation","isCorrect":true,"score":0.75,"comment":"Good","explanation":"Because"}'),
      { type: 'evaluation', isCorrect: true, score: 0.75, comment: 'Good', explanation: 'Because' }
    )
    const ungraded = parseVoiceEvent('{"type":"evaluation","isCorrect":false,"score":0,"comment":"","explanation":"","ungraded":true}')
    assert.equal(ungraded?.type === 'evaluation' && ungraded.ungraded, true)
  })

  it('keeps the page links of a wrong answer and of a closed idea, and drops one that links away', () => {
    const links = '[{"label":"pp. 4-6","href":"/api/materials/m1/file#page=4"},{"label":"p. 9","href":"https://example.com/x"},{"label":"p. 2","href":"//example.com/x"},{"href":"/a"}]'
    const wrong = parseVoiceEvent(`{"type":"evaluation","isCorrect":false,"score":0,"comment":"","explanation":"","lookLinks":${links}}`)
    assert.deepEqual(wrong?.type === 'evaluation' && wrong.lookLinks, [{ label: 'pp. 4-6', href: '/api/materials/m1/file#page=4' }])
    const closed = parseVoiceEvent(`{"type":"idea_done","name":"Collision","outcome":"taught","lookAgain":["pp. 4-6"],"lookLinks":${links}}`)
    assert.deepEqual(closed?.type === 'idea_done' && closed.lookLinks, [{ label: 'pp. 4-6', href: '/api/materials/m1/file#page=4' }])
  })

  it('parses a board update with its page link, and drops one that is not well formed or links away', () => {
    assert.deepEqual(
      parseVoiceEvent('{"type":"board","kind":"claim","text":"The mean is $\\\\mu$.","question":"Why?","source":{"label":"p. 14","href":"/api/materials/m1/file#page=14"}}'),
      { type: 'board', kind: 'claim', text: 'The mean is $\\mu$.', question: 'Why?', source: { label: 'p. 14', href: '/api/materials/m1/file#page=14' } }
    )
    assert.deepEqual(parseVoiceEvent('{"type":"board","kind":"concept","text":"Explain collisions"}'), { type: 'board', kind: 'concept', text: 'Explain collisions' })
    assert.deepEqual(
      parseVoiceEvent('{"type":"board","kind":"concept","text":"Explain collisions","idea":{"name":"Collision","conceptId":"c1"}}'),
      { type: 'board', kind: 'concept', text: 'Explain collisions', idea: { name: 'Collision', conceptId: 'c1' } }
    )
    assert.equal(parseVoiceEvent('{"type":"board","kind":"claim","text":"  "}'), null)
    assert.equal(parseVoiceEvent('{"type":"board","kind":"other","text":"x"}'), null)
    const away = parseVoiceEvent('{"type":"board","kind":"claim","text":"x","source":{"label":"p. 1","href":"https://example.com"}}')
    assert.deepEqual(away, { type: 'board', kind: 'claim', text: 'x' })
  })

})

describe('readVoiceEvents', () => {
  it('reads events split across chunks and skips junk lines', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      '{"type":"text","del',
      'ta":"Hello"}\nnot json\n{"type":"text","delta":" there"}\n{"type":"do',
      'ne","text":"Hello there"}',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const events: VoiceEvent[] = []
    for await (const event of readVoiceEvents(body)) events.push(event)
    assert.deepEqual(events, [
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' there' },
      { type: 'done', text: 'Hello there' },
    ])
  })
})

/** Feed `text` through a chunker `size` characters at a time. */
function chunk(text: string, size: number, options?: { minChars?: number }): string[] {
  const chunker = createSentenceChunker(options)
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)))
  out.push(...chunker.flush())
  return out
}

describe('createSentenceChunker', () => {
  it('splits on . ! ? and gives the same sentences however the text is cut up', () => {
    const text = 'That is right. Well done! Shall we go on? Yes.'
    const expected = ['That is right.', 'Well done!', 'Shall we go on?', 'Yes.']
    for (const size of [1, 2, 3, 7, 100]) assert.deepEqual(chunk(text, size), expected, `size ${size}`)
  })

  it('does not split after abbreviations or initials', () => {
    assert.deepEqual(chunk('Ask Dr. Smith about it. Use e.g. a hash map, i.e. a table. Then J. K. Rowling vs. Tolkien.', 5), [
      'Ask Dr. Smith about it.',
      'Use e.g. a hash map, i.e. a table.',
      'Then J. K. Rowling vs. Tolkien.',
    ])
  })

})
