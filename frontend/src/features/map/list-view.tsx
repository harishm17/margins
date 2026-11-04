import Link from 'next/link'
import { FrontierBadge } from './frontier-badge'
import { StateIcon } from './state-icon'
import { MathText } from '@/components/ui/math-text'
import { frontierTexts, LABEL_TEXT } from '@/lib/map/copy'
import { relationsOf } from '@/lib/map/relations'
import type { MapEdge, MapNode } from '@/server/queries/map'
import { cn } from '@/lib/utils'

/**
 * The unit as an ordered list grouped by topic (spec §9): the same concepts in the same order as the map,
 * each with its state in words and how it connects, so the list is a full alternative to the picture.
 */
export function ListView({
  nodes,
  edges,
  selectedId,
  hrefFor,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  selectedId: string | null
  hrefFor: (nodeId: string) => string
}) {
  const frontier = frontierTexts(nodes)
  const groups: { topicId: string; topicName: string; nodes: MapNode[] }[] = []
  for (const node of nodes) {
    const last = groups[groups.length - 1]
    if (last && last.topicId === node.topicId) last.nodes.push(node)
    else groups.push({ topicId: node.topicId, topicName: node.topicName, nodes: [node] })
  }
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.topicId} aria-labelledby={`map-topic-${group.topicId}`}>
          <h3 id={`map-topic-${group.topicId}`} className="text-heading text-fg">
            {group.topicName}
          </h3>
          <ol className="mt-2 divide-y divide-border rounded-card border border-border bg-surface">
            {group.nodes.map((node) => {
              const relations = relationsOf(node.id, nodes, edges)
              const selected = node.id === selectedId
              return (
                <li key={node.id}>
                  <Link
                    href={hrefFor(node.id)}
                    scroll={false}
                    aria-current={selected ? 'true' : undefined}
                    data-node-link=""
                    className={cn(
                      'flex flex-col gap-1 rounded-card px-4 py-3 transition-colors duration-120 hover:bg-surface-2',
                      // The chosen idea is marked by a bar as well as the tint, so colour is not the only signal.
                      selected && 'bg-surface-2 shadow-[inset_3px_0_0_var(--accent)]'
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-body-strong text-fg">
                        <MathText>{node.name}</MathText>
                      </span>
                      {/* One verdict per row: where to start, else next up, else the state (the icon and a hidden word still carry the state). */}
                      <span className="inline-flex items-center gap-1.5 text-small text-fg-2">
                        <StateIcon label={node.label} size={14} />
                        {frontier[node.id] ? <span className="sr-only">{LABEL_TEXT[node.label]}. </span> : LABEL_TEXT[node.label]}
                      </span>
                      {frontier[node.id] ? <FrontierBadge text={frontier[node.id]} /> : null}
                    </span>
                    {relations.map((relation) => (
                      <span key={relation.label} className="text-small text-fg-2">
                        {/* A suggested link is detailed once the idea is chosen; the row only names the ideas. */}
                        {relation.label}: {relation.names.map((name) => name.replace(' (suggested)', '')).join(', ')}
                      </span>
                    ))}
                  </Link>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
