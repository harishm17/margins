import type { MissKind } from '@/lib/tutor/state'

/**
 * How a recall answer becomes concept scores (spec §5.3). Pure.
 *
 * The grader gives a verdict per claim. Covered is 1, partial 0.5, missing 0 and incorrect 0, and a concept's
 * score is the mean over its claims. A concept with an incorrect claim also carries the wrong idea and its kind
 * of miss, and one with claims left out carries a cue miss: those are the names the learner model reads
 * (EvidenceEvent.metadata.missKind and .misconception, lib/learning/memory.ts).
 */

export type ClaimVerdictKind = 'covered' | 'partial' | 'missing' | 'incorrect'

export type ScoredClaim = {
  conceptId: string
  verdict: ClaimVerdictKind
  /** The kind of miss the grader named for an incorrect claim. */
  kind?: MissKind | null
  /** The wrong idea the grader found in an incorrect claim. */
  misconception?: string | null
}

export type ConceptRecallScore = {
  conceptId: string
  score: number
  /** Set when a claim was wrong, or when claims were left out and the concept did not pass. */
  missKind?: MissKind
  /** The wrong idea, set with a missKind of misconception or discrimination. */
  misconception?: string
}

const VERDICT_SCORES: Record<ClaimVerdictKind, number> = { covered: 1, partial: 0.5, missing: 0, incorrect: 0 }

/** Below this a concept has not been recalled (the same line mastery uses for a pass). */
const PASS = 0.75

/** The kinds in the order that decides which one names the concept when claims disagree. */
const KIND_ORDER: MissKind[] = ['misconception', 'discrimination', 'execution', 'careless', 'cue_miss']

export const verdictScore = (verdict: ClaimVerdictKind): number => VERDICT_SCORES[verdict]

/** One score per concept, in the order the concepts first appear. A claim with no concept is left out. */
export function conceptRecallScores(claims: ScoredClaim[]): ConceptRecallScore[] {
  const byConcept = new Map<string, ScoredClaim[]>()
  for (const claim of claims) {
    if (!claim.conceptId) continue
    byConcept.set(claim.conceptId, [...(byConcept.get(claim.conceptId) ?? []), claim])
  }
  return [...byConcept].map(([conceptId, own]) => {
    const score = own.reduce((sum, claim) => sum + verdictScore(claim.verdict), 0) / own.length
    const wrong = own.filter((claim) => claim.verdict === 'incorrect')
    const result: ConceptRecallScore = { conceptId, score }
    if (wrong.length > 0) {
      const named = wrong.map((claim) => ({ claim, kind: claim.kind ?? 'misconception' }))
      named.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      const lead = named[0]
      result.missKind = lead.kind
      const idea = lead.claim.misconception?.trim()
      if (idea) result.misconception = idea
    } else if (score < PASS && own.some((claim) => claim.verdict === 'missing')) {
      result.missKind = 'cue_miss'
    }
    return result
  })
}
