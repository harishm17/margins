import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clip, focusPlaceholder, minutesLabel, minutesLeftLabel } from './format'

describe('minutesLeftLabel', () => {
  it('rounds down to whole minutes and handles the edges', () => {
    assert.equal(minutesLeftLabel(18 * 60 + 40), '18 min left today')
    assert.equal(minutesLeftLabel(60), '1 min left today')
    assert.equal(minutesLeftLabel(59), 'Under 1 min left today')
    assert.equal(minutesLeftLabel(0), '0 min left today')
    assert.equal(minutesLeftLabel(-5), '0 min left today')
  })
})

describe('minutesLabel', () => {
  it('pluralises', () => {
    assert.equal(minutesLabel(1), '1 minute')
    assert.equal(minutesLabel(12), '12 minutes')
  })
})

describe('clip', () => {
  it('leaves short text alone and cuts long text on a word', () => {
    assert.equal(clip('Why does BFS find shortest paths?'), 'Why does BFS find shortest paths?')
    const long = 'Explain why breadth first search finds shortest paths in unweighted graphs but not in weighted graphs with varied edge costs, and what to use instead'
    const out = clip(long, 60)
    assert.ok(out.endsWith('...'))
    assert.ok(out.length <= 60)
    assert.doesNotMatch(out, /\s\.\.\.$/)
  })
})

describe('focusPlaceholder', () => {
  it("uses the topic's first key term that fits", () => {
    assert.equal(focusPlaceholder(['Bayes rule', 'priors']), 'e.g. Bayes rule')
    assert.equal(focusPlaceholder(['  ', 'a key term written as a whole long sentence of words', '  base  rates ']), 'e.g. base rates')
  })

  it('falls back to an example that suits any course', () => {
    assert.equal(focusPlaceholder([]), 'e.g. the definitions I keep mixing up')
    assert.equal(focusPlaceholder(), 'e.g. the definitions I keep mixing up')
  })
})
