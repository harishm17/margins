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
    assert.equal(first, 'Ask me to explain “Conditional probability” in my own words, then check what I say.')
    assert.equal(second, 'Give me a question on “TCP handshake” to try, then check my answer.')
    assert.equal(third, 'What should I look for before I read about “Bayes\' theorem”?')
  })

  it('fills up with generic questions when there are few topics', () => {
    const questions = exampleQuestions(['Hash tables'])
    assert.equal(questions.length, 3)
    assert.match(questions[0], /Hash tables/)
    assert.doesNotMatch(questions[1], /Hash tables/)
  })

  it('never offers a plain explanation or summary: the student tries or looks first', () => {
    const all = [...exampleQuestions(['A', 'B', 'C', 'D'], 3), ...exampleQuestions([]), ...exampleQuestions(['A', 'B', 'C'], 6)]
    for (const question of all) assert.doesNotMatch(question, /simple terms|^Summari[sz]e|^Explain\b/i)
  })

  it('works with no topics and ignores blank names', () => {
    assert.equal(exampleQuestions([]).length, 3)
    assert.equal(exampleQuestions(['  ', '']).length, 3)
    assert.doesNotMatch(exampleQuestions(['  '])[0], /\s{2}/)
  })
})
