import * as React from 'react'
import Link from 'next/link'
import { CaretRight } from '@phosphor-icons/react/dist/ssr'
import { StateIcon, STATE_TONE } from './state-icon'
import { frontierKeyText, frontierTexts, LABEL_ORDER, LABEL_TEXT } from '@/lib/map/copy'
import { BADGE_RADIUS, NODE_HEIGHT, NODE_WIDTH, type MapLayout } from '@/lib/map/layout'
import { wrapName } from '@/lib/map/wrap'
import { relationsOf, relationsSentence } from '@/lib/map/relations'
import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import type { MapEdge, MapNode } from '@/server/queries/map'
import { cn } from '@/lib/utils'

// The unit as an SVG (spec §9). Nodes are links, in the same order as the list view, so the keyboard
// moves through them as the list reads. Each node says its state in words next to its icon.

const NAME_WIDTH = 25
const NAME_LINES = 2
const RING = 4

const NODE_CLASS: Record<ConceptLabel, string> = {
  solid: 'fill-accent-soft stroke-accent',
  getting_there: 'fill-surface stroke-accent',
  shaky: 'fill-warning-soft stroke-warning',
  fading: 'fill-surface stroke-warning',
  inferred: 'fill-surface-2 stroke-border-strong',
  not_started: 'fill-surface stroke-border-strong',
}

type Point = { x: number; y: number }

/** Where the line from the centre of a node toward `to` leaves its box. */
function edgePoint(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return from
  const scale = Math.min(dx === 0 ? Infinity : NODE_WIDTH / 2 / Math.abs(dx), dy === 0 ? Infinity : NODE_HEIGHT / 2 / Math.abs(dy))
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

function linkPath(from: Point, to: Point): string {
  const start = { x: from.x, y: from.y + NODE_HEIGHT / 2 }
  const end = { x: to.x, y: to.y - NODE_HEIGHT / 2 - 2 }
  if (end.y <= start.y) {
    // Same row, or a cycle among suggested links: a side to side curve.
    const a = edgePoint(from, to)
    const b = edgePoint(to, from)
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  }
  const mid = (start.y + end.y) / 2
  return `M ${start.x} ${start.y} C ${start.x} ${mid}, ${end.x} ${mid}, ${end.x} ${end.y}`
}

export function MapView({
  nodes,
  edges,
  layout,
  selectedId,
  hrefFor,
  label,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  layout: MapLayout
  selectedId: string | null
  hrefFor: (nodeId: string) => string
  label: string
}) {
  const nameOf = new Map(nodes.map((node) => [node.id, node.name]))
  const frontier = frontierTexts(nodes)
  return (
    <div>
      <p className="mb-2 text-small text-fg-3 sm:hidden">Scroll sideways, or use List view.</p>
      <div
        role="region"
        aria-label={`${label}, scrolls sideways`}
        tabIndex={0}
        className="scroll-cue-x overflow-x-auto overflow-y-hidden rounded-card border border-border outline-none focus-visible:ring-2 focus-visible:ring-fg"
      >
        {/* The picture fits the frame, down to 90% of its size (the smallest text is then still about 11px); narrower than that (and always on a phone) it scrolls, with a soft edge on the side that has more. */}
        <svg
          role="group"
          aria-label={label}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ '--map-w': `${layout.width}px` } as React.CSSProperties}
          className="mx-auto block h-auto w-full max-w-(--map-w) min-w-[calc(var(--map-w)*0.9)] max-sm:min-w-(--map-w)"
        >
          <defs>
            <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-fg-3" />
            </marker>
            {/* How each idea connects, in words: the lines are drawn for the eye only, so a screen reader reads this with the idea. */}
            {nodes.map((node) => {
              const sentence = relationsSentence(relationsOf(node.id, nodes, edges))
              return sentence ? <desc key={node.id} id={`map-relations-${node.id}`}>{sentence}</desc> : null
            })}
            <marker id="map-arrow-suggested" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-border-strong" />
            </marker>
          </defs>
          <g aria-hidden="true">
          {edges.map((edge) => {
            const source = layout.positions[edge.sourceId]
            const target = layout.positions[edge.targetId]
            if (!source || !target) return null
            const suggested = edge.status === 'proposed'
            const sourceName = nameOf.get(edge.sourceId) ?? ''
            const targetName = nameOf.get(edge.targetId) ?? ''
            if (edge.type === 'confusable') {
              // Not a line with an arrow, so it cannot be read as "needs": a dotted line with a "≈" in a round badge.
              const a = edgePoint(source, target)
              const b = edgePoint(target, source)
              return (
                <g key={edge.id}>
                  <title>{`${sourceName} and ${targetName} are easy to mix up${suggested ? ' (suggested)' : ''}`}</title>
                  <path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="0.1 6" className="stroke-fg-3" />
                  <MixUpBadge x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} />
                </g>
              )
            }
            // A prerequisite runs from the concept needed first; an encompasses link is drawn from the one it covers.
            const [from, to] = edge.type === 'prerequisite' ? [source, target] : [target, source]
            const text =
              edge.type === 'prerequisite' ? `${targetName} needs ${sourceName}` : `${sourceName} covers ${targetName}`
            return (
              <path
                key={edge.id}
                d={linkPath(from, to)}
                fill="none"
                strokeWidth={1.5}
                className={suggested ? 'stroke-border-strong' : 'stroke-fg-3'}
                markerEnd={suggested ? 'url(#map-arrow-suggested)' : 'url(#map-arrow)'}
              >
                <title>{`${text}${suggested ? ' (suggested)' : ''}`}</title>
              </path>
            )
          })}
          </g>
          {nodes.map((node) => {
            const at = layout.positions[node.id]
            if (!at) return null
            const left = at.x - NODE_WIDTH / 2
            const top = at.y - NODE_HEIGHT / 2
            const selected = node.id === selectedId
            const lines = wrapName(node.name, NAME_WIDTH, NAME_LINES)
            const state = LABEL_TEXT[node.label]
            return (
              <Link
                key={node.id}
                href={hrefFor(node.id)}
                scroll={false}
                aria-current={selected ? 'true' : undefined}
                aria-describedby={relationsOf(node.id, nodes, edges).length > 0 ? `map-relations-${node.id}` : undefined}
                data-node-link=""
                className="group outline-none"
              >
                {node.frontier ? (
                  <rect x={left - RING} y={top - RING} width={NODE_WIDTH + RING * 2} height={NODE_HEIGHT + RING * 2} rx={14} fill="none" strokeWidth={2} className="stroke-accent" />
                ) : null}
                <rect
                  x={left}
                  y={top}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={10}
                  strokeWidth={selected ? 3 : 1.5}
                  className={cn(NODE_CLASS[node.label], selected && 'stroke-fg', 'transition-[stroke-width] duration-120 group-hover:stroke-fg')}
                />
                <rect
                  x={left - RING - 3}
                  y={top - RING - 3}
                  width={NODE_WIDTH + (RING + 3) * 2}
                  height={NODE_HEIGHT + (RING + 3) * 2}
                  rx={17}
                  fill="none"
                  strokeWidth={2.5}
                  className="stroke-fg opacity-0 group-focus-visible:opacity-100"
                />
                {lines.map((line, index) => (
                  <text key={index} x={left + 12} y={top + 22 + index * 16} className="fill-fg text-small font-medium">
                    {line}
                  </text>
                ))}
                <StateIcon label={node.label} size={14} x={left + 12} y={top + NODE_HEIGHT - 24} />
                <text x={left + 31} y={top + NODE_HEIGHT - 12} className={cn('fill-fg-2 text-caption')}>
                  {state}
                </text>
                {frontier[node.id] ? (
                  <text x={left + NODE_WIDTH - 12} y={top + NODE_HEIGHT - 12} textAnchor="end" className="fill-fg text-caption font-medium">
                    {frontier[node.id]}
                  </text>
                ) : null}
              </Link>
            )
          })}
        </svg>
      </div>
      <MapKey nodes={nodes} edges={edges} />
    </div>
  )
}

/** The "easy to mix up" mark: a round badge with a bold "≈" (two drawn waves, so it reads the same in every font), on the dotted line between two ideas. The layout leaves room for it. */
function MixUpBadge({ x, y }: { x: number; y: number }) {
  const wave = (offset: number) => `M ${x - 9} ${y + offset} q 4.5 -5 9 0 t 9 0`
  return (
    <g data-mix-badge="">
      <circle cx={x} cy={y} r={BADGE_RADIUS} strokeWidth={2} className="fill-surface stroke-fg-3" />
      <path d={wave(-3.5)} fill="none" strokeWidth={2.6} strokeLinecap="round" className="stroke-fg" />
      <path d={wave(3.5)} fill="none" strokeWidth={2.6} strokeLinecap="round" className="stroke-fg" />
    </g>
  )
}

/**
 * What the map's shapes mean, in words, behind one "Key" button (the map is the point; the key is for when you
 * wonder). It lists only what this unit shows: the states its ideas are in and the kinds of line it draws.
 */
function MapKey({ nodes, edges }: { nodes: MapNode[]; edges: MapEdge[] }) {
  const states = LABEL_ORDER.filter((label) => nodes.some((node) => node.label === label))
  const has = (type: string) => edges.some((edge) => edge.type === type)
  const lines = [
    has('prerequisite') || has('encompasses')
      ? {
          key: 'leads',
          text: 'Leads to',
          mark: (
            <svg aria-hidden="true" width="28" height="10" className="shrink-0">
              <line x1="0" y1="5" x2="22" y2="5" strokeWidth="1.5" className="stroke-fg-3" />
              <path d="M 20 1.5 L 27 5 L 20 8.5 z" className="fill-fg-3" />
            </svg>
          ),
        }
      : null,
    has('confusable')
      ? {
          key: 'mix',
          text: 'Easy to mix up',
          mark: (
            <svg aria-hidden="true" width="52" height="30" className="shrink-0">
              <line x1="0" y1="15" x2="8" y2="15" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="0.1 6" className="stroke-fg-3" />
              <MixUpBadge x={26} y={15} />
              <line x1="44" y1="15" x2="52" y2="15" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="0.1 6" className="stroke-fg-3" />
            </svg>
          ),
        }
      : null,
    edges.some((edge) => edge.status === 'proposed')
      ? {
          key: 'suggested',
          text: 'Suggested, not confirmed',
          mark: (
            <svg aria-hidden="true" width="28" height="10" className="shrink-0">
              <line x1="0" y1="5" x2="22" y2="5" strokeWidth="1.5" className="stroke-border-strong" />
              <path d="M 20 1.5 L 27 5 L 20 8.5 z" className="fill-border-strong" />
            </svg>
          ),
        }
      : null,
    nodes.some((node) => node.frontier)
      ? {
          key: 'next',
          text: frontierKeyText(nodes.filter((node) => node.frontier).length),
          mark: (
            <svg aria-hidden="true" width="28" height="14" className="shrink-0">
              <rect x="2" y="2" width="24" height="10" rx="4" fill="none" strokeWidth="2" className="stroke-accent" />
            </svg>
          ),
        }
      : null,
  ].filter((line) => line !== null)
  return (
    <details className="group mt-3 text-small text-fg-2">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip text-fg-2 hover:text-fg max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <CaretRight aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-90" />
        Key
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <ul aria-label="States" className="flex flex-wrap gap-x-4 gap-y-1.5">
          {states.map((label) => (
            <li key={label} className="inline-flex items-center gap-1.5">
              <StateIcon label={label} size={14} className={STATE_TONE[label]} />
              {LABEL_TEXT[label]}
            </li>
          ))}
        </ul>
        {lines.length > 0 ? (
          <ul aria-label="Lines and rings" className="flex flex-wrap gap-x-4 gap-y-1.5">
            {lines.map((line) => (
              <li key={line.key} className="inline-flex items-center gap-1.5">
                {line.mark}
                {line.text}
              </li>
            ))}
          </ul>
        ) : null}
        {nodes.some((node) => node.label === 'inferred') ? (
          <p className="text-caption text-fg-3">Inferred means credited through a related idea and not yet tested on its own.</p>
        ) : null}
      </div>
    </details>
  )
}
