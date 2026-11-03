/**
 * The probing rules of the voice teach-back (spec §5.8). Pure: no database, no network.
 *
 * The recall grader gives a verdict per claim of the concept the student explained. This file turns the
 * verdicts into gaps, picks the kind of probe each gap calls for, counts probes per gap and decides when the
 * coach may explain. The state it moves lives on the session row (`coachState`), written by the tools, so the
 * model cannot talk itself past the two probes.
 *
 * What the grader found, and the probe it calls for (learn-codebase's Socratic question types, with the
 * examples written for course material):
 *   a vague or ambiguous term -> clarification
 *   an unsupported jump       -> evidence
 *   a missing claim           -> implication or prediction
 *   an incorrect claim        -> assumption first, then confront (§6.2)
 *   a missing prerequisite    -> back to the source or the prerequisite
 *
 * A student who says "I don't know", or whose explanation covers no claim, and has had nothing explained on the concept yet,
 * is not probed (spec 18.6): the first gap is explained at once from its claim, and the student says it back. That gap's
 * probes are spent. Later gaps get `probesBeforeExplaining(band)` probes: one in band 0, two otherwise.
 */

import { probesBeforeExplaining, type Band } from '@/lib/learning/level'

export type Finding = 'incorrect' | 'vague' | 'unsupported_jump' | 'missing_prerequisite' | 'missing'
export type ProbeType = 'clarification' | 'evidence' | 'implication' | 'assumption' | 'confront' | 'source'

export type ProbeKind = {
  probe: ProbeType
  /** What the coach is doing, in a few words. */
  label: string
  /** One example line, to be worded for the student's own answer, never read out as it stands. */
  example: string
}

/** The grader's finding, the probe it calls for and one example (spec §5.8). */
export const PROBE_FOR_FINDING: Record<Finding, ProbeKind> = {
  vague: { probe: 'clarification', label: 'clarification', example: "When you say 'it balances', what exactly is equal to what?" },
  unsupported_jump: { probe: 'evidence', label: 'evidence', example: 'What in your notes on p. 14 tells you that?' },
  missing: { probe: 'implication', label: 'implication or prediction', example: "If that's true, what happens when the sample doubles?" },
  incorrect: { probe: 'assumption', label: 'assumption', example: 'What are you assuming about independence there?' },
  missing_prerequisite: {
    probe: 'source',
    label: 'back to the prerequisite',
    example: 'Before this: how would you define a conditional probability?',
  },
}

/** The second probe on an incorrect claim: a case where the idea predicts the wrong thing (§6.2, Confront). */
export const CONFRONT_PROBE: ProbeKind = {
  probe: 'confront',
  label: 'confront',
  example: 'Try that idea on a small case: what does it predict, and does that match what your pages say?',
}

/** Band assumed when the caller does not know the concept's (core). */
const DEFAULT_BAND: Band = 1

/** Gaps are taken in this order: what the student said wrongly or loosely before what they left out. */
const FINDING_ORDER: Finding[] = ['incorrect', 'vague', 'unsupported_jump', 'missing_prerequisite', 'missing']

export type Verdict = 'covered' | 'partial' | 'missing' | 'incorrect'

/** One claim of the concept with the grader's verdict, in the claims' own order. */
export type AssessedClaim = {
  claimId: string
  text: string
  page: number | null
  verdict: Verdict
  studentQuote?: string | null
  misconception?: string | null
  pointer?: string | null
  /**
   * The grader's judgement of a covered claim: true when it was stated without the support the source gives for it, false
   * when the support was there, null or absent when it did not say (the position of the claim then stands in).
   */
  reasoningGap?: boolean | null
}

export type Gap = {
  claimId: string
  finding: Finding
  /** The page the probe can name: the claim's own page. */
  page: number | null
}

export type GapOptions = {
  /** Name of a prerequisite of the concept that the student does not hold yet, if there is one. */
  weakPrerequisite?: string | null
}

export type PlanOptions = GapOptions & {
  /** What the student just said was an "I don't know" (`isDontKnow` on the heard text). */
  dontKnow?: boolean
  /** The concept's support band (`conceptBand`): one probe before explaining a gap in band 0, two otherwise. */
  band?: Band
}

/**
 * The gaps in an assessment, in the order they are probed.
 * - an incorrect claim is `incorrect`; a partial one is `vague` (the grader found the idea but not the precise term);
 * - a covered claim the grader flagged `reasoningGap` is an `unsupported_jump`: the student states the conclusion without
 *   the support the source gives. When the grader did not say, a covered claim whose predecessor in the source is missing
 *   stands in for it (the conclusion without the step before it);
 * - a missing claim is `missing`, or `missing_prerequisite` when the student covered nothing of the concept and
 *   a prerequisite is weak.
 */
export function findGaps(claims: AssessedClaim[], options: GapOptions = {}): Gap[] {
  const coveredSomething = claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
  const gaps: Gap[] = []
  claims.forEach((claim, position) => {
    if (claim.verdict === 'incorrect') gaps.push({ claimId: claim.claimId, finding: 'incorrect', page: claim.page })
    else if (claim.verdict === 'partial') gaps.push({ claimId: claim.claimId, finding: 'vague', page: claim.page })
    else if (claim.verdict === 'missing') {
      const finding: Finding = !coveredSomething && options.weakPrerequisite ? 'missing_prerequisite' : 'missing'
      gaps.push({ claimId: claim.claimId, finding, page: claim.page })
    } else if (claim.reasoningGap === true || ((claim.reasoningGap === null || claim.reasoningGap === undefined) && position > 0 && claims[position - 1].verdict === 'missing')) {
      gaps.push({ claimId: claim.claimId, finding: 'unsupported_jump', page: claim.page })
    }
  })
  return gaps
    .map((gap, position) => ({ gap, position }))
    .sort((a, b) => FINDING_ORDER.indexOf(a.gap.finding) - FINDING_ORDER.indexOf(b.gap.finding) || a.position - b.position)
    .map((entry) => entry.gap)
}

/** The probe for a gap's n-th probe (0 for the first). An incorrect claim gets the assumption, then the confrontation. */
export function probeFor(finding: Finding, probesSoFar: number): ProbeKind {
  if (finding === 'incorrect' && probesSoFar >= 1) return CONFRONT_PROBE
  return PROBE_FOR_FINDING[finding]
}

export type GapState = { probes: number; explained: boolean }

/** Where the explanation of one concept stands. */
export type ConceptState = {
  /** Explanations assessed so far. */
  assessments: number
  /** What the student has said about the idea, in order. The follow-up answers are assessed together with it. */
  said: string[]
  gaps: Record<string, GapState>
  /** The gap whose explanation the coach just gave: the next answer is the student saying it back. */
  sayBack: string | null
  /** The new example or prediction has been asked. */
  exampleAsked: boolean
  /** How the concept closed: explained (every claim, and the new example held), or taught (the coach had to explain). */
  outcome: 'explained' | 'taught' | null
}

export const emptyConceptState = (): ConceptState => ({ assessments: 0, said: [], gaps: {}, sayBack: null, exampleAsked: false, outcome: null })

export type Plan =
  | { action: 'probe'; gap: Gap; probe: ProbeKind; probeNumber: number }
  | { action: 'explain'; gap: Gap }
  | { action: 'explain_first'; gap: Gap }
  | { action: 'ask_new_example' }
  | { action: 'wrap_up' }

/**
 * What the coach does next after an assessment, and the state after it. Never mutates its input.
 * - An "I don't know", or an explanation that covers no claim, before anything was explained on the concept: the coach
 *   explains the first open gap at once (`explain_first`), with no probe, and the student says it back.
 * - The first open gap decides. It gets up to `probesBeforeExplaining(band)` probes; after that the coach explains in
 *   one or two sentences from the claim and asks the student to say it back, and that gap is closed whatever the
 *   answer (the escape after the failed probes).
 * - With no gap left and the student's own words covering every claim, the coach asks one small new example or
 *   prediction before the concept counts as explained, because memorised wording can hide a gap.
 * - With no gap left but the coach having explained something, the concept is taught, not explained.
 */
export function planNext(claims: AssessedClaim[], before: ConceptState, options: PlanOptions = {}): { plan: Plan; state: ConceptState } {
  const probesAllowed = probesBeforeExplaining(options.band ?? DEFAULT_BAND)
  const state: ConceptState = { ...before, assessments: before.assessments + 1, gaps: { ...before.gaps } }
  // Whether anything was explained on this concept before this assessment: the say-back that this one answers counts.
  const alreadyExplained = before.sayBack !== null || Object.values(before.gaps).some((gap) => gap.explained)
  if (state.sayBack) {
    const said = state.gaps[state.sayBack] ?? { probes: probesAllowed, explained: false }
    state.gaps[state.sayBack] = { ...said, explained: true }
    state.sayBack = null
  }
  const open = findGaps(claims, options).filter((gap) => !state.gaps[gap.claimId]?.explained)
  if (open.length === 0) {
    const taught = Object.values(state.gaps).some((gap) => gap.explained)
    const allCovered = claims.every((claim) => claim.verdict === 'covered')
    // Until the new example is answered (record_check) the idea is not closed: an assessment in the meantime asks for it again.
    if (!taught && allCovered && !state.outcome) {
      state.exampleAsked = true
      return { plan: { action: 'ask_new_example' }, state }
    }
    state.outcome = taught ? 'taught' : state.outcome
    return { plan: { action: 'wrap_up' }, state }
  }
  const gap = open[0]
  const coversNothing = !claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
  if ((options.dontKnow === true || coversNothing) && !alreadyExplained) {
    state.gaps[gap.claimId] = { probes: probesAllowed, explained: false }
    state.sayBack = gap.claimId
    return { plan: { action: 'explain_first', gap }, state }
  }
  const probes = state.gaps[gap.claimId]?.probes ?? 0
  if (probes >= probesAllowed) {
    state.sayBack = gap.claimId
    return { plan: { action: 'explain', gap }, state }
  }
  state.gaps[gap.claimId] = { probes: probes + 1, explained: false }
  return { plan: { action: 'probe', gap, probe: probeFor(gap.finding, probes), probeNumber: probes + 1 }, state }
}

/**
 * The new example or prediction was answered. Passing closes the concept as explained. Failing goes back through
 * the gaps with what the example showed (a claim the example does not touch is not a gap here).
 */
export function afterExample(
  claims: AssessedClaim[],
  before: ConceptState,
  passed: boolean,
  options: PlanOptions = {}
): { plan: Plan; state: ConceptState } {
  if (passed) return { plan: { action: 'wrap_up' }, state: { ...before, outcome: 'explained' } }
  const shown = claims.map((claim) => (claim.verdict === 'missing' ? { ...claim, verdict: 'covered' as const } : claim))
  const next = planNext(shown, { ...before, exampleAsked: true }, options)
  // Nothing wrong came out of it: the example did not show the idea, so the concept is taught, not explained.
  if (next.plan.action === 'ask_new_example') return { plan: { action: 'wrap_up' }, state: { ...next.state, outcome: next.state.outcome ?? 'taught' } }
  if (next.plan.action === 'wrap_up') next.state.outcome = next.state.outcome ?? 'taught'
  return next
}

/** The example passes when it holds no wrong claim and shows at least one claim of the concept. */
export function exampleHeld(claims: AssessedClaim[]): boolean {
  return !claims.some((claim) => claim.verdict === 'incorrect') && claims.some((claim) => claim.verdict === 'covered' || claim.verdict === 'partial')
}
