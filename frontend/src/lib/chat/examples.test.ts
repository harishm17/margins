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

  it('works with no topics and ignores blank names', () => {
    assert.equal(exampleQuestions([]).length, 3)
    assert.equal(exampleQuestions(['  ', '']).length, 3)
    assert.doesNotMatch(exampleQuestions(['  '])[0], /\s{2}/)
  })
})
