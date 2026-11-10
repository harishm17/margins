import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cleanForSpeech,
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
    // "pp. 12" was cut in two; "no." and "ch." are short for a word only before a number.
    assert.deepEqual(chunk('See pp. 12 to 14, ch. 3 and no. 5. Is it done? The answer is no. Go on.', 4), [
      'See pp. 12 to 14, ch. 3 and no. 5.',
      'Is it done?',
      'The answer is no.',
      'Go on.',
    ])
  })

  it('ends a sentence in Chinese, Japanese and Hindi (a whole reply was held back until its end, then said in one piece)', () => {
    const cases: Array<[string, string[]]> = [
      ['熵永远不会减少。这是第二定律！明白吗？好的。', ['熵永远不会减少。', '这是第二定律！', '明白吗？', '好的。']],
      ['エントロピーは減らない。「はい。」それが第二法則です。', ['エントロピーは減らない。', '「はい。」', 'それが第二法則です。']],
      ['एन्ट्रॉपी कभी कम नहीं होती। यह दूसरा नियम है। ठीक है?', ['एन्ट्रॉपी कभी कम नहीं होती।', 'यह दूसरा नियम है।', 'ठीक है?']],
    ]
    for (const [text, expected] of cases) {
      for (const size of [1, 3, 100]) assert.deepEqual(chunk(text, size), expected, `${text} at size ${size}`)
    }
    // The first sentence is ready before the reply ends: nothing waits for the flush.
    assert.deepEqual(createSentenceChunker().push('熵永远不会减少。这是'), ['熵永远不会减少。'])
  })

  it('keeps display maths written over several lines in one piece (each line was read out as loose symbols)', () => {
    const text = 'So we have\n$$\nx = 1\n\\\\ y = 2.\n$$\nand that is all. Next.'
    for (const size of [1, 5, 100]) {
      assert.deepEqual(chunk(text, size), ['So we have', '$$\nx = 1\n\\\\ y = 2.\n$$', 'and that is all.', 'Next.'], `size ${size}`)
    }
  })
})

describe('cleanForSpeech', () => {
  it('drops emphasis marks and keeps the signs that are said (a star, a hash and an underscore were removed wherever they stood)', () => {
    assert.equal(cleanForSpeech('Use **bold**, *stars* and _under_ here.'), 'Use bold, stars and under here.')
    assert.equal(cleanForSpeech('In C# it is 2 * 3, at #1, with snake_case.'), 'In C# it is 2 * 3, at #1, with snake case.')
    assert.equal(cleanForSpeech('## A heading'), 'A heading')
    assert.equal(cleanForSpeech('Maths keeps its marks: $x_i * y_i$.'), 'Maths keeps its marks: $x_i * y_i$.')
  })

  it('says a link by its words and an address by its site (the whole address was read out)', () => {
    assert.equal(cleanForSpeech('See [the notes](https://example.com/a/b?c=d) first.'), 'See the notes first.')
    assert.equal(cleanForSpeech('It is at https://www.mit.edu/courses/6-006/x.html.'), 'It is at mit.edu.')
  })
})
