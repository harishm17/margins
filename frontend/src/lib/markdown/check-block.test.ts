import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCheckBlock } from './check-block'

describe('parseCheckBlock', () => {
  it('reads a question and an answer', () => {
    assert.deepEqual(parseCheckBlock('Q: What is $2+2$?\nA: $4$'), { question: 'What is $2+2$?', answer: '$4$' })
  })

  it('accepts bold labels and the long words', () => {
    assert.deepEqual(parseCheckBlock('**Q:** Why?\n**A:** Because.'), { question: 'Why?', answer: 'Because.' })
    assert.deepEqual(parseCheckBlock('Question: Why?\nAnswer: Because.'), { question: 'Why?', answer: 'Because.' })
  })

  it('gives null when it is not a question and answer', () => {
    assert.equal(parseCheckBlock('print("hi")'), null)
    assert.equal(parseCheckBlock('Q: Only a question'), null)
    assert.equal(parseCheckBlock('A: only an answer'), null)
    assert.equal(parseCheckBlock('Q:\nA: nothing asked'), null)
    assert.equal(parseCheckBlock('some text\nQ: late\nA: x'), null)
  })
})
