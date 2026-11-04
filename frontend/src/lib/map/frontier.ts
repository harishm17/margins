import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import { WEAK_PREREQUISITE_R } from '@/lib/learning/drill-select'

// The knowledge map's frontier ring (spec §9): the concepts worth doing next. Same line as the practice
// tutor's weak-prerequisite check, so "ready to build on" means one thing everywhere.
export const FRONTIER_RETRIEVABILITY = WEAK_PREREQUISITE_R

/**
 * A concept is on the frontier when every prerequisite has retrievability at or above the line and the
 * concept itself is not yet solid. A concept with no prerequisites qualifies until it is solid.
 */
/**
 * Why an idea is (or is not) ready, as one line for its panel: from the ideas it builds on, each flagged when the link is only
 * suggested. The ring itself tests recall of the confirmed and suggested prerequisites alike (isFrontier); this is the words.
 */
export function frontierReason(prerequisites: readonly { name: string; suggested: boolean }[]): string {
  if (prerequisites.length === 0) return 'No prerequisites: start here'
  const confirmed = prerequisites.filter((item) => !item.suggested).map((item) => item.name)
  const suggested = prerequisites.filter((item) => item.suggested).map((item) => item.name)
  const parts: string[] = []
  if (confirmed.length > 0) parts.push(`Builds on ${confirmed.join(', ')}`)
  if (suggested.length > 0) parts.push(`Builds on ${suggested.join(', ')} (suggested connection, not confirmed)`)
  return parts.join('. ')
}

export function isFrontier(label: ConceptLabel, prerequisiteRetrievabilities: number[]): boolean {
  if (label === 'solid') return false
  return prerequisiteRetrievabilities.every((r) => r >= FRONTIER_RETRIEVABILITY)
}
