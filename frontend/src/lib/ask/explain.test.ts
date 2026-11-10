import assert from 'node:assert/strict'
import test from 'node:test'
import { explainMistakeHref, explainMistakeMessage, MAX_QUESTION_CHARS } from './explain'

const sources = [
  { materialId: 'm1', filename: 'lecture3.pdf', pageStart: 4, pageEnd: 4 },
  { materialId: 'm1', filename: 'lecture3.pdf', pageStart: 5, pageEnd: 6 },
]

test('the message carries the question, the answer and where it comes from', () => {
  const message = explainMistakeMessage({ questionText: 'What is $O(n)$?', studentAnswer: 'Constant time', sources })
  assert.match(message, /^Explain this mistake\./)
  assert.match(message, /Question: What is \$O\(n\)\$\?/)
  assert.match(message, /My answer: Constant time/)
  assert.match(message, /Where it comes from: lecture3\.pdf, pp\. 4-6/)
})

test('a long question and answer are cut to fit the Ask box', () => {
  const message = explainMistakeMessage({ questionText: 'q'.repeat(5000), studentAnswer: 'a'.repeat(5000), sources })
  assert.ok(message.length < MAX_QUESTION_CHARS, `${message.length} characters`)
})

test('the link names the course and topic and carries the message as q', () => {
  const href = explainMistakeHref('c1', 't1', { questionText: 'Q', studentAnswer: 'A' })
  const url = new URL(href, 'https://example.com')
  assert.equal(url.pathname, '/courses/c1/ask')
  assert.equal(url.searchParams.get('topic'), 't1')
  assert.match(url.searchParams.get('q') ?? '', /Question: Q/)
  assert.equal(new URL(explainMistakeHref('c1', null, { questionText: 'Q', studentAnswer: 'A' }), 'https://example.com').searchParams.has('topic'), false)
})
