import dagre from '@dagrejs/dagre'

// Knowledge map layout (spec §9): dagre, top to bottom, prerequisites above dependents.
export const NODE_WIDTH = 184
export const NODE_HEIGHT = 72
const NODE_SEP = 28
const RANK_SEP = 64
const MARGIN = 16
/** The round "easy to mix up" badge sits on the line between a pair, in the gap between their boxes. */
export const BADGE_RADIUS = 14
/** Room kept clear on each side of the badge, so it never touches a box. */
const BADGE_CLEAR = 10
/** What a pair of easily mixed-up ideas needs between their boxes, beside the usual gap, for the badge to sit clear. */
export const PAIR_GAP = BADGE_RADIUS * 2 + BADGE_CLEAR * 2

export type LayoutNode = { id: string }
export type LayoutEdge = { sourceId: string; targetId: string; type: string }

export type MapLayout = {
  /** The centre of each node. */
  positions: Record<string, { x: number; y: number }>
  width: number
  height: number
}

/**
 * Only prerequisite and encompasses edges rank the nodes. A prerequisite runs from the concept needed
 * first to the one that needs it; an encompasses edge runs from the more advanced concept to the one it
 * exercises, so it is turned round and the simpler concept sits above. Confusable edges are not given to
 * dagre: they are drawn by the caller between the positions this returns. A pair that is easy to mix up is given a
 * wider gap (each box is spaced as if it were wider by half of it), so the badge on their line sits between the boxes.
 */
export function layoutMap(nodes: LayoutNode[], edges: LayoutEdge[]): MapLayout {
  if (nodes.length === 0) return { positions: {}, width: 0, height: 0 }

  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN })
  graph.setDefaultEdgeLabel(() => ({}))
  const pairs = new Set<string>()
  for (const edge of edges) if (edge.type === 'confusable') pairs.add(edge.sourceId).add(edge.targetId)
  const room = Math.max(0, PAIR_GAP - NODE_SEP)
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH + (pairs.has(node.id) ? room : 0), height: NODE_HEIGHT })

  for (const edge of edges) {
    if (!graph.hasNode(edge.sourceId) || !graph.hasNode(edge.targetId)) continue
    if (edge.type === 'prerequisite') graph.setEdge(edge.sourceId, edge.targetId)
    else if (edge.type === 'encompasses') graph.setEdge(edge.targetId, edge.sourceId)
  }

  dagre.layout(graph)

  const positions: MapLayout['positions'] = {}
  for (const node of nodes) {
    const placed = graph.node(node.id)
    positions[node.id] = { x: placed.x, y: placed.y }
  }
  const { width = 0, height = 0 } = graph.graph()
  return { positions, width, height }
}
