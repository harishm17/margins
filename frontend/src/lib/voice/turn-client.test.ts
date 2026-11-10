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

  it('parses a question without options and fills defaults', () => {
    assert.deepEqual(parseVoiceEvent('{"type":"question","index":0,"text":"Why?"}'), {
      type: 'question',
      index: 0,
      total: 0,
      text: 'Why?',
      questionType: 'conceptual',
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

  it('parses the v3.2 working and listen events and drops ones it does not know', () => {
    assert.deepEqual(parseVoiceEvent('{"type":"working","step":"assess"}'), { type: 'working', step: 'assess' })
    assert.deepEqual(parseVoiceEvent('{"type":"working","step":"record_check"}'), { type: 'working', step: 'record_check' })
    assert.equal(parseVoiceEvent('{"type":"working","step":"grade"}'), null)
    assert.equal(parseVoiceEvent('{"type":"working"}'), null)
    assert.deepEqual(parseVoiceEvent('{"type":"listen","for":"explanation"}'), { type: 'listen', for: 'explanation' })
    assert.deepEqual(parseVoiceEvent('{"type":"listen","for":"none"}'), { type: 'listen', for: 'none' })
    assert.equal(parseVoiceEvent('{"type":"listen","for":"essay"}'), null)
  })

  it('parses text, hint, session_complete, done and error', () => {
    assert.deepEqual(parseVoiceEvent('{"type":"text","delta":"Hi "}'), { type: 'text', delta: 'Hi ' })
    assert.deepEqual(parseVoiceEvent('{"type":"hint","text":"Think about it"}'), { type: 'hint', text: 'Think about it' })
    assert.deepEqual(parseVoiceEvent('{"type":"session_complete"}'), { type: 'session_complete' })
    assert.deepEqual(parseVoiceEvent('{"type":"done","text":"All set."}'), { type: 'done', text: 'All set.' })
    assert.deepEqual(parseVoiceEvent('{"type":"error","code":"LLM_UNAVAILABLE","message":"Busy","retryable":true}'), {
      type: 'error',
      code: 'LLM_UNAVAILABLE',
      message: 'Busy',
      retryable: true,
    })
    const bare = parseVoiceEvent('{"type":"error"}')
    assert.deepEqual(bare, { type: 'error', code: 'VOICE_TURN_FAILED', message: '', retryable: true })
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

  it('holds a sentence back until the next one starts, so the first can be spoken early', () => {
    const chunker = createSentenceChunker()
    assert.deepEqual(chunker.push('Good job.'), [])
    assert.deepEqual(chunker.push(' '), [])
    assert.deepEqual(chunker.push('Now'), ['Good job.'])
    assert.deepEqual(chunker.flush(), ['Now'])
    // A single sentence with no space after it comes out only on flush.
    const single = createSentenceChunker()
    assert.deepEqual(single.push('Done.'), [])
    assert.deepEqual(single.flush(), ['Done.'])
  })

  it('splits on newlines, even without punctuation', () => {
    assert.deepEqual(chunk('First line\nSecond line\n\nThird', 4), ['First line', 'Second line', 'Third'])
  })

  it('keeps decimals intact', () => {
    assert.deepEqual(chunk('Pi is about 3.14 and e is 2.718. That is it.', 3), [
      'Pi is about 3.14 and e is 2.718.',
      'That is it.',
    ])
  })

  it('does not split after abbreviations or initials', () => {
    assert.deepEqual(chunk('Ask Dr. Smith about it. Use e.g. a hash map, i.e. a table. Then J. K. Rowling vs. Tolkien.', 5), [
      'Ask Dr. Smith about it.',
      'Use e.g. a hash map, i.e. a table.',
      'Then J. K. Rowling vs. Tolkien.',
    ])
  })

  it('does not split before a lower-case word', () => {
    assert.deepEqual(chunk('Lists, sets, etc. and maps are collections. Next one.', 6), [
      'Lists, sets, etc. and maps are collections.',
      'Next one.',
    ])
  })

  it('treats an ellipsis and repeated marks as one end', () => {
    assert.deepEqual(chunk('Hmm... let me think. Really?! Yes.', 4), ['Hmm...', 'let me think.', 'Really?!', 'Yes.'])
  })

  it('keeps a closing quote or bracket with its sentence', () => {
    assert.deepEqual(chunk('He said "stop." Then (quietly.) we left.', 3), ['He said "stop."', 'Then (quietly.) we left.'])
  })

  it('returns the unfinished tail on flush', () => {
    const chunker = createSentenceChunker()
    assert.deepEqual(chunker.push('One. Two and a half'), ['One.'])
    assert.deepEqual(chunker.flush(), ['Two and a half'])
    assert.deepEqual(chunker.flush(), [])
  })

  it('merges short sentences into the next one with minChars', () => {
    assert.deepEqual(chunk('Yes. That is correct, nicely done. Ok.', 5, { minChars: 12 }), [
      'Yes. That is correct, nicely done.',
      'Ok.',
    ])
  })

  it('strips markdown a synthesizer would read aloud', () => {
    assert.equal(cleanForSpeech('**Great** answer, use `a map` here.'), 'Great answer, use a map here.')
    assert.equal(cleanForSpeech('- First point'), 'First point')
    assert.equal(cleanForSpeech('## Heading'), 'Heading')
    assert.equal(cleanForSpeech('Use $x_i + y_j$ and **bold** here.'), 'Use $x_i + y_j$ and bold here.')
    assert.equal(cleanForSpeech('It costs $5 and *then* $10.'), 'It costs $5 and then $10.')
    assert.deepEqual(chunk('**Nice.** Next one.', 4), ['Nice.', 'Next one.'])
  })
})
