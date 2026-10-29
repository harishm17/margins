import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleQuestions } from './examples'

describe('exampleQuestions', () => {
  it('builds one question per topic, in topic order', () => {
    const questions = exampleQuestions(['Hash tables', 'Heaps', 'Graphs', 'Tries'])
    assert.equal(questions.length, 3)
    assert.match(questions[0], /Hash tables/)
    assert.match(questions[1], /Heaps/)
    assert.match(questions[2], /Graphs/)
    assert.equal(new Set(questions).size, 3)
  })

  it('quotes the topic name as written, so a title-cased name reads correctly mid-sentence', () => {
    const [first, second, third] = exampleQuestions(['Conditional probability', 'TCP handshake', "Bayes' theorem"])
    assert.equal(first, 'Explain “Conditional probability” in simple terms.')
    assert.equal(second, 'What are the key points about “TCP handshake”?')
    assert.equal(third, 'Give me an example that shows “Bayes\' theorem”.')
  })

  it('fills up with generic questions when there are few topics', () => {
    const questions = exampleQuestions(['Hash tables'])
    assert.equal(questions.length, 3)
    assert.match(questions[0], /Hash tables/)
    assert.doesNotMatch(questions[1], /Hash tables/)
  })

  it('works with no topics and ignores blank names', () => {
    assert.equal(exampleQuestions([]).length, 3)
    assert.equal(exampleQuestions(['  ', '']).length, 3)
    assert.doesNotMatch(exampleQuestions(['  '])[0], /\s{2}/)
  })
})
