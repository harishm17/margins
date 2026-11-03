import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import { WEAK_PREREQUISITE_R } from '@/lib/learning/drill-select'

// The knowledge map's frontier ring (spec §9): the concepts worth doing next. Same line as the practice
// tutor's weak-prerequisite check, so "ready to build on" means one thing everywhere.
export const FRONTIER_RETRIEVABILITY = WEAK_PREREQUISITE_R

/**
 * A concept is on the frontier when every prerequisite has retrievability at or above the line and the
 * concept itself is not yet solid. A concept with no prerequisites qualifies until it is solid.
 */
export function isFrontier(label: ConceptLabel, prerequisiteRetrievabilities: number[]): boolean {
  if (label === 'solid') return false
  return prerequisiteRetrievabilities.every((r) => r >= FRONTIER_RETRIEVABILITY)
}
