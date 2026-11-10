import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupByConcept, recallOutcome, recallSummary } from './recall-shared'

const got = (conceptName: string, partial = false) => ({ conceptName, quote: 'q', partial })
const missed = (conceptName: string, claimId = conceptName) => ({ claimId, conceptName, pointer: 'p' })

describe('recallOutcome', () => {
  it('counts an idea that is covered and also missed in a claim as part covered, not as nothing', () => {
    // The OCW run: two claims of one idea covered, a third missed, and a second idea wholly missed.
    const outcome = recallOutcome({
      got: [got('Define a problem'), got('Define a problem')],
      wrong: [],
      missed: [missed('Define a problem', 'c3'), missed('What an algorithm solves', 'c4'), missed('What an algorithm solves', 'c5')],
    })
    assert.deepEqual(outcome, { total: 2, full: 0, partly: 1 })
    assert.equal(recallSummary(outcome), 'You covered 0 of 2 ideas completely, and 1 partly.')
  })

  it('counts whole, part and missing ideas separately', () => {
    const outcome = recallOutcome({ got: [got('A'), got('B', true)], wrong: [], missed: [missed('C')] })
    assert.deepEqual(outcome, { total: 3, full: 1, partly: 1 })
    assert.equal(recallSummary(outcome), 'You covered 1 of 3 ideas completely, and 1 partly.')
  })

  it('treats a wrong claim as a gap in its idea', () => {
    const wrong = { conceptName: 'A', studentQuote: 's', misconception: 'm', sourceQuote: 'q', page: null }
    assert.deepEqual(recallOutcome({ got: [got('A')], wrong: [wrong], missed: [] }), { total: 1, full: 0, partly: 1 })
  })

})

describe('groupByConcept', () => {
  it('names each idea once, in the order met', () => {
    const groups = groupByConcept([missed('B', '1'), missed('A', '2'), missed('B', '3')])
    assert.deepEqual(groups.map((g) => [g.conceptName, g.items.length]), [['B', 2], ['A', 1]])
  })
})
