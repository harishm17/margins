import { Rating } from 'ts-fsrs'

// FIRe-lite: fractional implicit repetition along the concept graph (spec §3.7).

export const FIRE = {
  maxDepth: 3,
  minPathWeight: 0.1,
  minProposedConfidence: 0.7,
  penaltyFactor: 0.5,
}

export type EdgeRow = {
  id: string
  sourceId: string
  targetId: string
  type: string
  weight: number
  confidence: number
  status: string
}

export type ImplicitTarget = {
  targetId: string
  direction: 'credit' | 'penalty'
  pathWeight: number
  /** The last edge on the path to the target. */
  edgeId: string
  /** Every edge the path walked, in order (for a penalty, the one edge). Rejecting any of them takes the credit back. */
  pathEdgeIds: string[]
}

export function usable(edge: Pick<EdgeRow, 'type' | 'status' | 'confidence'>): boolean {
  if (edge.type !== 'encompasses') return false
  if (edge.status === 'confirmed') return true
  return edge.status === 'proposed' && edge.confidence >= FIRE.minProposedConfidence
}

// Good or Easy on a concept credits what it encompasses; Again penalises what encompasses it.
// Whether the target has a card, or has failed lately, is decided on replay, not here.
export function implicitEventsFor(
  conceptId: string,
  rating: Rating,
  edges: EdgeRow[]
): ImplicitTarget[] {
  const live = edges.filter(usable)
  if (rating === Rating.Again) {
    return live
      .filter((e) => e.targetId === conceptId && e.sourceId !== conceptId)
      .map((e) => ({
        targetId: e.sourceId,
        direction: 'penalty' as const,
        pathWeight: e.weight,
        edgeId: e.id,
        pathEdgeIds: [e.id],
      }))
  }
  if (rating !== Rating.Good && rating !== Rating.Easy) return []

  const bySource = new Map<string, EdgeRow[]>()
  for (const edge of live) {
    const list = bySource.get(edge.sourceId) ?? []
    list.push(edge)
    bySource.set(edge.sourceId, list)
  }
  // One event per reached concept, carrying the strongest path to it.
  const best = new Map<string, ImplicitTarget>()
  const walk = (from: string, weight: number, depth: number, visited: Set<string>, walked: string[]) => {
    if (depth >= FIRE.maxDepth) return
    for (const edge of bySource.get(from) ?? []) {
      const next = weight * edge.weight
      if (next < FIRE.minPathWeight || visited.has(edge.targetId)) continue
      const known = best.get(edge.targetId)
      if (!known || next > known.pathWeight) {
        best.set(edge.targetId, {
          targetId: edge.targetId,
          direction: 'credit',
          pathWeight: next,
          edgeId: edge.id,
          pathEdgeIds: [...walked, edge.id],
        })
      }
      walk(edge.targetId, next, depth + 1, new Set(visited).add(edge.targetId), [...walked, edge.id])
    }
  }
  walk(conceptId, 1, 0, new Set([conceptId]), [])
  return [...best.values()]
}
