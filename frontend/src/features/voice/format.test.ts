import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clip, minutesLeftLabel, sessionLine } from './format'

describe('minutesLeftLabel', () => {
  it('rounds down to whole minutes and handles the edges', () => {
    assert.equal(minutesLeftLabel(18 * 60 + 40), '18 min left today')
    assert.equal(minutesLeftLabel(60), '1 min left today')
    assert.equal(minutesLeftLabel(59), 'Under 1 min left today')
    assert.equal(minutesLeftLabel(0), '0 min left today')
    assert.equal(minutesLeftLabel(-5), '0 min left today')
  })
})

describe('sessionLine', () => {
  it('says talked for spoken answers, typed for typed ones, and both when mixed', () => {
    assert.equal(sessionLine({ seconds: 12 * 60, exchanges: 3, typed: 0 }, false), 'You talked for 12 minutes.')
    assert.equal(sessionLine({ seconds: 40, exchanges: 1, typed: 1 }, false), 'You typed for under a minute.')
    assert.equal(sessionLine({ seconds: 180, exchanges: 4, typed: 1 }, true), 'You talked and typed for 3 minutes and sent 4 messages.')
    assert.equal(sessionLine({ seconds: 120, exchanges: 1, typed: 1 }, true), 'You typed for 2 minutes and sent 1 message.')
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
