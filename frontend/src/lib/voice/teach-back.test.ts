import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  afterExample,
  emptyConceptState,
  findGaps,
  planNext,
  probeFor,
  type AssessedClaim,
  type ConceptState,
  type Verdict,
} from './teach-back'

const claim = (id: string, verdict: Verdict, page: number | null = 14, extra: Partial<AssessedClaim> = {}): AssessedClaim => ({
  claimId: id,
  text: `Claim ${id}.`,
  page,
  verdict,
  ...extra,
})

describe('findGaps', () => {
  it('maps each verdict to the grader finding the spec names', () => {
    const gaps = findGaps([claim('a', 'covered'), claim('b', 'partial'), claim('c', 'incorrect'), claim('d', 'missing')])
    assert.deepEqual(
      gaps.map((gap) => [gap.claimId, gap.finding]),
      [
        ['c', 'incorrect'],
        ['b', 'vague'],
        ['d', 'missing'],
      ]
    )
  })

  it('a covered claim after a missing step is an unsupported jump, probed before what was left out', () => {
    const gaps = findGaps([claim('a', 'missing', 13), claim('b', 'covered', 14)])
    assert.deepEqual(
      gaps.map((gap) => [gap.claimId, gap.finding, gap.page]),
      [
        ['b', 'unsupported_jump', 14],
        ['a', 'missing', 13],
      ]
    )
  })

  it('a missing claim is a missing prerequisite only when nothing of the concept was covered and a prerequisite is weak', () => {
    assert.equal(findGaps([claim('a', 'missing')], { weakPrerequisite: 'Conditional probability' })[0].finding, 'missing_prerequisite')
    assert.equal(findGaps([claim('a', 'missing')])[0].finding, 'missing')
    assert.equal(findGaps([claim('a', 'covered'), claim('b', 'missing')], { weakPrerequisite: 'X' })[0].finding, 'missing')
  })

})

describe('planNext', () => {
  const wrong = [claim('a', 'incorrect', 4, { misconception: 'x' }), claim('b', 'covered', 5)]

  it('probes the first gap twice, then explains and asks for it back', () => {
    let state: ConceptState = emptyConceptState()
    const first = planNext(wrong, state)
    assert.equal(first.plan.action, 'probe')
    assert.equal(first.plan.action === 'probe' && first.plan.probe.probe, 'assumption')
    state = first.state
    const second = planNext(wrong, state)
    assert.equal(second.plan.action === 'probe' && second.plan.probe.probe, 'confront')
    assert.equal(second.plan.action === 'probe' && second.plan.probeNumber, 2)
    const third = planNext(wrong, second.state)
    assert.equal(third.plan.action, 'explain')
    assert.equal(third.state.sayBack, 'a')
    // An incorrect claim gets an assumption probe, then confront.
    assert.equal(probeFor('incorrect', 0).probe, 'assumption')
    assert.equal(probeFor('incorrect', 1).probe, 'confront')
    assert.equal(probeFor('vague', 1).probe, 'clarification')
  })

  it('full coverage asks one new example before marking explained', () => {
    const all = [claim('a', 'covered'), claim('b', 'covered')]
    const first = planNext(all, emptyConceptState())
    assert.equal(first.plan.action, 'ask_new_example')
    assert.equal(first.state.outcome, null, 'not explained yet')
    const held = afterExample(all, first.state, true)
    assert.equal(held.state.outcome, 'explained')
    // A wrong tool order (assessing again before the example is answered) does not close the idea: the example is asked again.
    const again = planNext(all, first.state)
    assert.equal(again.plan.action, 'ask_new_example')
    assert.equal(again.state.outcome, null)
  })

})

describe('the grader reasoning flag', () => {
  it('a covered claim flagged as stated without its reason is an unsupported jump, whatever its neighbour', () => {
    const gaps = findGaps([claim('a', 'covered', 4, { reasoningGap: false }), claim('b', 'covered', 5, { reasoningGap: true })])
    assert.deepEqual(gaps.map((gap) => [gap.claimId, gap.finding, gap.page]), [['b', 'unsupported_jump', 5]])
  })

  it('an answer that is fully covered but bare gets the evidence probe first and the new example once the reason is there', () => {
    const bare = [claim('a', 'covered', 4, { reasoningGap: false }), claim('b', 'covered', 5, { reasoningGap: true })]
    const first = planNext(bare, emptyConceptState())
    assert.equal(first.plan.action === 'probe' && first.plan.probe.probe, 'evidence')
    assert.equal(first.plan.action === 'probe' && first.plan.gap.page, 5)
    const reasoned = [claim('a', 'covered', 4, { reasoningGap: false }), claim('b', 'covered', 5, { reasoningGap: false })]
    assert.equal(planNext(reasoned, first.state).plan.action, 'ask_new_example')
  })
})

describe('explain first (spec 18.6)', () => {
  it('idk gives explain_first with no probes', () => {
    const covered = [claim('a', 'covered'), claim('b', 'missing', 5)]
    // "I don't know" explains the first gap at once, even when the verdicts on file hold something covered.
    const first = planNext(covered, emptyConceptState(), { dontKnow: true })
    assert.equal(first.plan.action, 'explain_first')
    assert.equal(first.plan.action === 'explain_first' && first.plan.gap.claimId, 'b')
    assert.equal(first.state.sayBack, 'b')
    assert.equal(first.state.gaps.b.probes, 2)
    // Said back: the gap closes and the idea is taught.
    const back = planNext([claim('a', 'covered'), claim('b', 'covered', 5)], first.state)
    assert.equal(back.plan.action, 'wrap_up')
    assert.equal(back.state.outcome, 'taught')
  })

})
