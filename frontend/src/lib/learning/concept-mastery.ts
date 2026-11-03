import { fsrs, generatorParameters } from 'ts-fsrs'
import { FSRS_PARAMS, type ConceptMemoryState } from './memory'

// Concept and topic mastery (spec §3.6). Pure: the state comes from replayConcept.

export type ConceptKind = 'fact' | 'concept' | 'procedure' | 'judgment'
export type ConceptLabel =
  | 'not_started'
  | 'inferred'
  | 'shaky'
  | 'getting_there'
  | 'solid'
  | 'fading'

// Oldest to newest. With fewer than five scores the newest still gets 1.
export const RECENCY_WEIGHTS = [0.5, 0.7, 0.85, 0.95, 1]
// Level-0 ratings so far -> cap. Three or more are uncapped. A rating is a session-collapsed group
// (spec §3.5: level-0 events with one sessionKey are one rating), so a ten-question quiz counts once.
// Spec §3.6 words this as "level-0 events"; the collapsed reading keeps one sitting from lifting the cap.
export const EVIDENCE_CAP: Record<number, number> = { 1: 0.5, 2: 0.8 }

const SOLID = 0.8
const SHAKY = 0.4
const FADING_RETRIEVABILITY = 0.7
// Just under the solid threshold: the ceiling while a solid-rule gate is not met.
const BELOW_SOLID = 0.79

const scheduler = fsrs(generatorParameters(FSRS_PARAMS))

/** The recency-weighted mean (spec 3.6) of up to five scores, oldest first; null for none. The band model reads it without the cap. */
export function recencyWeightedMean(scores: number[]): number | null {
  if (scores.length === 0) return null
  const weights = RECENCY_WEIGHTS.slice(RECENCY_WEIGHTS.length - scores.length)
  const total = weights.reduce((sum, w) => sum + w, 0)
  return scores.reduce((sum, s, i) => sum + s * weights[i], 0) / total
}

const quality = (scores: number[]): number => recencyWeightedMean(scores)!

function evidenceCap(count: number): number {
  if (count >= 3) return 1
  return EVIDENCE_CAP[count] ?? 0
}

export function conceptMastery(
  state: ConceptMemoryState,
  kind: ConceptKind,
  now: Date
): { mastery: number; label: ConceptLabel; retrievability: number } {
  const retrievability = state.card ? scheduler.get_retrievability(state.card, now, false) : 0
  const scores = state.level0Scores.map((s) => s.score)

  if (scores.length === 0) {
    const label: ConceptLabel =
      state.lastEvidenceAt === null
        ? 'not_started'
        : state.nAssisted === 0
          ? 'inferred'
          : 'shaky'
    return { mastery: 0, label, retrievability }
  }

  let cap = evidenceCap(scores.length)
  if (!state.delayedNewSuccess) cap = Math.min(cap, BELOW_SOLID)
  if (kind === 'judgment' && !state.explainedWell) cap = Math.min(cap, BELOW_SOLID)
  const potential = Math.min(cap, quality(scores))
  const mastery = potential * retrievability

  let label: ConceptLabel
  if (potential >= SOLID && retrievability < FADING_RETRIEVABILITY) label = 'fading'
  else if (mastery >= SOLID) label = 'solid'
  else if (mastery >= SHAKY) label = 'getting_there'
  else label = 'shaky'
  return { mastery, label, retrievability }
}

// Untouched concepts are in the list with mastery 0.
export function topicMasteryFromConcepts(items: { mastery: number }[]): number {
  if (items.length === 0) return 0
  return items.reduce((sum, i) => sum + i.mastery, 0) / items.length
}
