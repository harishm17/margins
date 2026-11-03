import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PROBE_FOR_FINDING,
  afterExample,
  emptyConceptState,
  exampleHeld,
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

  it('has no gaps when every claim is covered', () => {
    assert.deepEqual(findGaps([claim('a', 'covered'), claim('b', 'covered')]), [])
  })
})

describe('the probe for a finding', () => {
  it('follows the spec table', () => {
    assert.equal(PROBE_FOR_FINDING.vague.probe, 'clarification')
    assert.equal(PROBE_FOR_FINDING.unsupported_jump.probe, 'evidence')
    assert.equal(PROBE_FOR_FINDING.missing.probe, 'implication')
    assert.equal(PROBE_FOR_FINDING.incorrect.probe, 'assumption')
    assert.equal(PROBE_FOR_FINDING.missing_prerequisite.probe, 'source')
    assert.equal(PROBE_FOR_FINDING.vague.example, "When you say 'it balances', what exactly is equal to what?")
    assert.equal(PROBE_FOR_FINDING.unsupported_jump.example, 'What in your notes on p. 14 tells you that?')
    assert.equal(PROBE_FOR_FINDING.missing.example, "If that's true, what happens when the sample doubles?")
    assert.equal(PROBE_FOR_FINDING.incorrect.example, 'What are you assuming about independence there?')
    assert.equal(PROBE_FOR_FINDING.missing_prerequisite.example, 'Before this: how would you define a conditional probability?')
  })

  it('incorrect claim gets an assumption probe then confront', () => {
    assert.equal(probeFor('incorrect', 0).probe, 'assumption')
    assert.equal(probeFor('incorrect', 1).probe, 'confront')
    assert.equal(probeFor('vague', 1).probe, 'clarification')
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
  })

  it('the answer said back closes the gap, whatever it was', () => {
    let state = emptyConceptState()
    for (let i = 0; i < 3; i += 1) state = planNext(wrong, state).state
    const after = planNext(wrong, state)
    assert.equal(after.plan.action, 'wrap_up')
    assert.equal(after.state.outcome, 'taught')
    assert.equal(after.state.sayBack, null)
  })

  it('a gap that closes on its own moves to the next one with a fresh count', () => {
    const two = [claim('a', 'partial'), claim('b', 'missing')]
    const first = planNext(two, emptyConceptState())
    assert.equal(first.plan.action === 'probe' && first.plan.gap.claimId, 'a')
    const fixed = [claim('a', 'covered'), claim('b', 'missing')]
    const second = planNext(fixed, first.state)
    assert.equal(second.plan.action === 'probe' && second.plan.gap.claimId, 'b')
    assert.equal(second.plan.action === 'probe' && second.plan.probeNumber, 1)
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

  it('a concept the coach had to explain is taught, not explained, and no example is asked', () => {
    let state = emptyConceptState()
    const gaps = [claim('a', 'missing')]
    for (let i = 0; i < 3; i += 1) state = planNext(gaps, state).state
    const fixed = planNext([claim('a', 'covered')], state)
    assert.equal(fixed.plan.action, 'wrap_up')
    assert.equal(fixed.state.outcome, 'taught')
  })

  it('a failed example goes back through what it got wrong, and ends taught when nothing was wrong', () => {
    const all = [claim('a', 'covered'), claim('b', 'covered')]
    const asked = planNext(all, emptyConceptState()).state
    const failed = afterExample([claim('a', 'incorrect'), claim('b', 'missing')], asked, false)
    assert.equal(failed.plan.action === 'probe' && failed.plan.gap.claimId, 'a')
    const untouched = afterExample([claim('a', 'missing'), claim('b', 'missing')], asked, false)
    assert.equal(untouched.plan.action, 'wrap_up')
    assert.equal(untouched.state.outcome, 'taught')
  })

  it('does not change the state it was given', () => {
    const before = emptyConceptState()
    planNext(wrong, before)
    assert.deepEqual(before, emptyConceptState())
  })

  it('unsupported jump gets an evidence probe naming the page', () => {
    const { plan } = planNext([claim('a', 'missing', 13), claim('b', 'covered', 14)], emptyConceptState())
    assert.equal(plan.action, 'probe')
    if (plan.action !== 'probe') return
    assert.equal(plan.probe.probe, 'evidence')
    assert.equal(plan.gap.page, 14)
  })
})

describe('the grader reasoning flag', () => {
  it('a covered claim flagged as stated without its reason is an unsupported jump, whatever its neighbour', () => {
    const gaps = findGaps([claim('a', 'covered', 4, { reasoningGap: false }), claim('b', 'covered', 5, { reasoningGap: true })])
    assert.deepEqual(gaps.map((gap) => [gap.claimId, gap.finding, gap.page]), [['b', 'unsupported_jump', 5]])
  })

  it('an explicit false is no jump even after a missing claim; absent falls back to the claim before it', () => {
    assert.deepEqual(findGaps([claim('a', 'missing'), claim('b', 'covered', 5, { reasoningGap: false })]).map((gap) => gap.finding), ['missing'])
    assert.deepEqual(findGaps([claim('a', 'missing'), claim('b', 'covered', 5, { reasoningGap: null })]).map((gap) => gap.finding), ['unsupported_jump', 'missing'])
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

describe('exampleHeld', () => {
  it('holds when nothing is wrong and something is shown', () => {
    assert.equal(exampleHeld([claim('a', 'covered'), claim('b', 'missing')]), true)
    assert.equal(exampleHeld([claim('a', 'partial')]), true)
    assert.equal(exampleHeld([claim('a', 'incorrect'), claim('b', 'covered')]), false)
    assert.equal(exampleHeld([claim('a', 'missing')]), false)
  })
})

describe('explain first (spec 18.6)', () => {
  const nothing = [claim('a', 'missing', 4), claim('b', 'missing', 5)]

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

  it('covering nothing gives explain_first', () => {
    const first = planNext(nothing, emptyConceptState())
    assert.equal(first.plan.action, 'explain_first')
    assert.equal(first.plan.action === 'explain_first' && first.plan.gap.claimId, 'a')
    // An incorrect claim covers nothing either.
    assert.equal(planNext([claim('a', 'incorrect', 4)], emptyConceptState()).plan.action, 'explain_first')
    // Covering something is probed as before.
    assert.equal(planNext([claim('a', 'covered'), claim('b', 'missing')], emptyConceptState()).plan.action, 'probe')
  })

  it('explains first only once: after something was explained the usual probes apply', () => {
    const first = planNext(nothing, emptyConceptState())
    // The say-back, then a second gap with nothing covered: probed, not explained again at once.
    const next = planNext(nothing, first.state)
    assert.equal(next.plan.action, 'probe')
    assert.equal(next.plan.action === 'probe' && next.plan.gap.claimId, 'b')
    // Even an "I don't know" on the next gap is a probe: nothing is "first" any more.
    const idk = planNext(nothing, first.state, { dontKnow: true })
    assert.equal(idk.plan.action, 'probe')
  })

  it('band 0 probes once before explaining', () => {
    const wrong = [claim('a', 'incorrect', 4, { misconception: 'x' }), claim('b', 'covered', 5)]
    const first = planNext(wrong, emptyConceptState(), { band: 0 })
    assert.equal(first.plan.action, 'probe')
    assert.equal(planNext(wrong, first.state, { band: 0 }).plan.action, 'explain')
    // Core and stretch take two.
    for (const band of [1, 2] as const) {
      const one = planNext(wrong, emptyConceptState(), { band })
      assert.equal(planNext(wrong, one.state, { band }).plan.action, 'probe')
    }
    // The gap explained first has its probes spent at the band's number.
    assert.equal(planNext([claim('a', 'missing', 4)], emptyConceptState(), { band: 0 }).state.gaps.a.probes, 1)
  })
})
