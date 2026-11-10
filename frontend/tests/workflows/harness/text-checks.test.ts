import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { conceptNameOf, misusedConcepts, unrenderedText } from './text-checks'

describe('concept names in sentences (SW3)', () => {
  const names = ['Tell a sample from a population', 'Define a confidence interval', 'Compute a sample mean']

  it('reads an idea name off its map node', () => {
    assert.equal(conceptNameOf('Define a confidence interval Inferred Start here'), 'Define a confidence interval')
    assert.equal(conceptNameOf('Interpret a p-value Not started'), 'Interpret a p-value')
    assert.equal(conceptNameOf('Describe the central limit theorem Getting there Next up'), 'Describe the central limit theorem')
  })

  it('finds an ability name used as the object of a sentence', () => {
    assert.deepEqual(misusedConcepts('Next You missed Tell a sample from a population last time.', names), [
      '"missed Tell a sample from a population"',
    ])
    assert.deepEqual(misusedConcepts('Re-read Define a confidence interval, p. 1', names), ['"Re-read Define a confidence interval"'])
    assert.deepEqual(misusedConcepts('A question about Compute a sample mean.', names), ['"about Compute a sample mean"'])
    assert.deepEqual(misusedConcepts('Ask me to explain Compute a sample mean in my own words', names), ['"explain Compute a sample mean"'])
    assert.deepEqual(misusedConcepts('Explain Define a confidence interval', names), ['"Explain Define a confidence interval"'])
  })

  it('accepts the name as a label, a heading or a list item', () => {
    assert.deepEqual(misusedConcepts('Next question: Compute a sample mean', names), [])
    assert.deepEqual(misusedConcepts('Define a confidence interval', names), [])
    assert.deepEqual(misusedConcepts('What you got Define a confidence interval You wrote it', names), [])
  })
})

describe('unrendered model text (SW2)', () => {
  it('passes rendered prose', () => {
    assert.deepEqual(unrenderedText('Given any sample of n readings, is the mean above the target?'), [])
    assert.deepEqual(unrenderedText('Section 3. The next part covers heaps.'), [])
    assert.deepEqual(unrenderedText('It costs $5 a month, or $50 a year.'), [])
  })

  it('finds maths left as LaTeX', () => {
    assert.deepEqual(unrenderedText('The running time is $O(n^2)$ in the worst case.'), ['raw maths: "$O(n^2)$"'])
    assert.deepEqual(unrenderedText('Its share is \\frac{1}{n} of the total.'), ['raw maths: "\\frac"'])
  })

  it('finds markdown markers left in the text', () => {
    assert.deepEqual(unrenderedText('keep **every** reading'), ['markdown: "**every**"'])
  })

  it('finds a numbered list run into one paragraph', () => {
    assert.deepEqual(
      unrenderedText('find the median. Is it above the mean? 3. Sort the readings. Is the order stable? 4. Explain why.'),
      ['list run together: "3. Sort the readings. Is the order stable? 4. Explain why."']
    )
  })
})
