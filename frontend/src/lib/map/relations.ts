import type { MapEdge, MapNode } from '@/server/queries/map'

/** How one concept of the unit relates to the others, in words, for the list view (the map draws the same links). */
export type Relation = { label: string; names: string[] }

/**
 * "Needs": the prerequisites. "Builds toward": the concepts that need it. "Covers" and "Part of": the encompasses
 * links. A suggested link (not yet confirmed) is marked in the name. Order follows the unit's own order.
 */
export function relationsOf(nodeId: string, nodes: Pick<MapNode, 'id' | 'name'>[], edges: Pick<MapEdge, 'sourceId' | 'targetId' | 'type' | 'status'>[]): Relation[] {
  const nameOf = new Map(nodes.map((node) => [node.id, node.name]))
  const order = new Map(nodes.map((node, index) => [node.id, index]))
  const named = (pairs: { id: string; status: string }[]) =>
    pairs
      .filter((pair) => nameOf.has(pair.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((pair) => `${nameOf.get(pair.id)}${pair.status === 'proposed' ? ' (suggested)' : ''}`)

  const pick = (type: MapEdge['type'], side: 'source' | 'target') =>
    named(
      edges
        .filter((edge) => edge.type === type && (side === 'source' ? edge.targetId === nodeId : edge.sourceId === nodeId))
        .map((edge) => ({ id: side === 'source' ? edge.sourceId : edge.targetId, status: edge.status }))
    )
  const mixedUp = named(
    edges
      .filter((edge) => edge.type === 'confusable' && (edge.sourceId === nodeId || edge.targetId === nodeId))
      .map((edge) => ({ id: edge.sourceId === nodeId ? edge.targetId : edge.sourceId, status: edge.status }))
  )

  const relations: Relation[] = [
    { label: 'Needs', names: pick('prerequisite', 'source') },
    { label: 'Needed by', names: pick('prerequisite', 'target') },
    { label: 'Covers', names: pick('encompasses', 'target') },
    { label: 'Covered by', names: pick('encompasses', 'source') },
    { label: 'Easy to mix up with', names: mixedUp },
  ]
  return relations.filter((relation) => relation.names.length > 0)
}

/** The relations as one sentence for a screen reader: "Needs A, B. Needed by C." Empty when there are none. */
export function relationsSentence(relations: Relation[]): string {
  return relations.map((relation) => `${relation.label} ${relation.names.join(', ')}.`).join(' ')
}
