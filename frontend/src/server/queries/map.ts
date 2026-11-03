import { prisma } from '@/lib/db/prisma'
import { conceptMastery, type ConceptKind, type ConceptLabel } from '@/lib/learning/concept-mastery'
import { stateFromMemoryRow } from '@/lib/learning/mastery'
import { needsInstruction } from '@/lib/learning/instruction'
import { helpAfterMiss, type HelpAfterMiss } from '@/lib/learning/instruction-server'
import { isFrontier } from '@/lib/map/frontier'

/** Everything here is filtered by the user id; a project or unit that is not theirs reads as an empty map. */

// A proposed link shows at this confidence or above (the link job's floor, as in review-bank.ts). A
// confirmed one always shows, and a rejected one never does.
export const MAP_EDGE_CONFIDENCE = 0.6

/** Where the idea is in the student's pages: its first claim, as a link that opens the reader there (spec 18.3). */
export type MapPointer = HelpAfterMiss['pointers'][number]

export type MapNode = {
  id: string
  name: string
  topicId: string
  topicName: string
  label: ConceptLabel
  retrievability: number
  /** ISO time of the next review; null before the first unaided answer. */
  dueAt: string | null
  frontier: boolean
  /** The latest retrieval failed and nothing has shown the idea since (spec 18.5): the panel leads with reading. */
  needsInstruction: boolean
  /** The first claim's passage, for a node that needs instruction; null otherwise. */
  pointer: MapPointer | null
}

export type MapEdge = {
  id: string
  sourceId: string
  targetId: string
  type: 'prerequisite' | 'encompasses' | 'confusable'
  status: 'proposed' | 'confirmed'
}

export type UnitMap = { nodes: MapNode[]; edges: MapEdge[] }

const EMPTY: UnitMap = { nodes: [], edges: [] }

const EDGE_TYPES: ReadonlySet<string> = new Set<MapEdge['type']>(['prerequisite', 'encompasses', 'confusable'])

const showsOnMap = (edge: { type: string; status: string; confidence: number }) =>
  EDGE_TYPES.has(edge.type) &&
  (edge.status === 'confirmed' || (edge.status === 'proposed' && edge.confidence >= MAP_EDGE_CONFIDENCE))

/**
 * The concepts of one unit with their state for this student, and the links among them. A null unit is the
 * course's topics that belong to no unit (a flat course, or a topic added by hand).
 */
export async function getUnitMap(userId: string, projectId: string, unitId: string | null, now: Date = new Date()): Promise<UnitMap> {
  const owned =
    unitId === null
      ? await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
      : await prisma.unit.findFirst({ where: { id: unitId, projectId, project: { userId } }, select: { id: true } })
  if (!owned) return EMPTY

  const concepts = await prisma.concept.findMany({
    where: { projectId, status: 'active', topic: { unitId, userConfirmed: true } },
    select: { id: true, name: true, kind: true, topicId: true, topic: { select: { name: true } } },
    orderBy: [{ topic: { orderIndex: 'asc' } }, { orderIndex: 'asc' }],
  })
  // A legacy unit, or one whose concepts are not extracted yet.
  if (concepts.length === 0) return EMPTY
  const inUnit = new Set(concepts.map((c) => c.id))

  const edgeRows = await prisma.conceptEdge.findMany({
    where: {
      projectId,
      status: { not: 'rejected' },
      OR: [{ sourceId: { in: [...inUnit] } }, { targetId: { in: [...inUnit] } }],
    },
    select: { id: true, sourceId: true, targetId: true, type: true, status: true, confidence: true },
    orderBy: { createdAt: 'asc' },
  })
  const visible = edgeRows.filter(showsOnMap)

  // A prerequisite from an earlier unit still gates the frontier, so its memory is read too.
  const prerequisitesOf = new Map<string, string[]>()
  for (const edge of visible) {
    if (edge.type !== 'prerequisite' || !inUnit.has(edge.targetId)) continue
    prerequisitesOf.set(edge.targetId, [...(prerequisitesOf.get(edge.targetId) ?? []), edge.sourceId])
  }
  const outside = [...new Set([...prerequisitesOf.values()].flat())].filter((id) => !inUnit.has(id))
  const [outsideConcepts, memoryRows] = await Promise.all([
    outside.length === 0
      ? Promise.resolve([])
      : prisma.concept.findMany({ where: { id: { in: outside }, projectId, status: 'active' }, select: { id: true, kind: true } }),
    prisma.conceptMemory.findMany({ where: { userId, projectId, conceptId: { in: [...inUnit, ...outside] } } }),
  ])
  const kindOf = new Map<string, ConceptKind>([...concepts, ...outsideConcepts].map((c) => [c.id, c.kind as ConceptKind]))
  const memoryOf = new Map(memoryRows.map((row) => [row.conceptId, row]))

  const stateOf = (id: string) => {
    const row = memoryOf.get(id)
    return row
      ? conceptMastery(stateFromMemoryRow(row), kindOf.get(id) ?? 'concept', now)
      : { mastery: 0, label: 'not_started' as ConceptLabel, retrievability: 0 }
  }

  // The ideas that are waiting for instruction, with where to read about each. One lookup per topic, none when nothing is waiting.
  const waiting = concepts.filter((concept) => {
    const row = memoryOf.get(concept.id)
    return row ? needsInstruction(stateFromMemoryRow(row)) : false
  })
  const pointerOf = new Map<string, MapPointer>()
  for (const topicId of new Set(waiting.map((concept) => concept.topicId))) {
    const help = await helpAfterMiss(prisma, { userId, topicId, conceptIds: waiting.filter((concept) => concept.topicId === topicId).map((concept) => concept.id), surface: 'map' })
    for (const pointer of help.pointers) pointerOf.set(pointer.conceptId, pointer)
  }
  const waitingIds = new Set(waiting.map((concept) => concept.id))

  const nodes: MapNode[] = concepts.map((concept) => {
    const { label, retrievability } = stateOf(concept.id)
    // A prerequisite that was merged away or removed no longer gates anything.
    const gates = (prerequisitesOf.get(concept.id) ?? []).filter((id) => kindOf.has(id))
    return {
      id: concept.id,
      name: concept.name,
      topicId: concept.topicId,
      topicName: concept.topic.name,
      label,
      retrievability,
      dueAt: memoryOf.get(concept.id)?.dueAt?.toISOString() ?? null,
      frontier: isFrontier(label, gates.map((id) => stateOf(id).retrievability)),
      needsInstruction: waitingIds.has(concept.id),
      pointer: pointerOf.get(concept.id) ?? null,
    }
  })

  const edges: MapEdge[] = visible
    .filter((edge) => inUnit.has(edge.sourceId) && inUnit.has(edge.targetId))
    .map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: edge.type as MapEdge['type'],
      status: edge.status as MapEdge['status'],
    }))

  return { nodes, edges }
}

export type MapUnit = { id: string | null; title: string; weekLabel: string | null; conceptCount: number }

export const OTHER_TOPICS_TITLE = 'Other topics'

/** The units that have concepts to show, in course order, then the topics that belong to no unit. */
export async function listMapUnits(userId: string, projectId: string): Promise<MapUnit[]> {
  const rows = await prisma.concept.findMany({
    where: { projectId, status: 'active', project: { userId }, topic: { userConfirmed: true } },
    select: { topic: { select: { unit: { select: { id: true, title: true, weekLabel: true, orderIndex: true } } } } },
  })
  const byUnit = new Map<string | null, MapUnit & { orderIndex: number }>()
  for (const { topic } of rows) {
    const unit = topic.unit
    const key = unit?.id ?? null
    const known = byUnit.get(key)
    if (known) known.conceptCount += 1
    else byUnit.set(key, { id: key, title: unit?.title ?? OTHER_TOPICS_TITLE, weekLabel: unit?.weekLabel ?? null, conceptCount: 1, orderIndex: unit?.orderIndex ?? Infinity })
  }
  return [...byUnit.values()].sort((a, b) => a.orderIndex - b.orderIndex).map(({ orderIndex: _order, ...unit }) => unit)
}

export type PanelClaim = { id: string; text: string; materialId: string; filename: string; pageStart: number | null; pageEnd: number | null }

export type PanelEvent = { id: string; source: string; score: number; assisted: boolean; createdAt: string }

/** How the other concept relates to the one in the panel, read from the panel concept's side. */
export type PanelLinkKind = 'needs' | 'needed_by' | 'covers' | 'covered_by' | 'confusable'

export type PanelLink = {
  edgeId: string
  kind: PanelLinkKind
  status: 'proposed' | 'confirmed'
  otherId: string
  otherName: string
}

export type ConceptPanel = {
  id: string
  name: string
  summary: string
  topicId: string
  topicName: string
  unitId: string | null
  label: ConceptLabel
  retrievability: number
  dueAt: string | null
  misconception: string | null
  claims: PanelClaim[]
  /** The newest five answers, newest first (an instruction is not an answer and is not listed). */
  events: PanelEvent[]
  links: PanelLink[]
  /** The latest retrieval failed and nothing has shown the idea since (spec 18.5): "Read about it first" leads. */
  needsInstruction: boolean
  /** The first claim's passage and, when the idea is waiting for instruction, the explanation to read: from `helpAfterMiss`. */
  pointer: MapPointer | null
  explainer: HelpAfterMiss['explainer']
}

const PANEL_EVENTS = 5

function linkKind(type: string, isSource: boolean): PanelLinkKind {
  if (type === 'prerequisite') return isSource ? 'needed_by' : 'needs'
  if (type === 'encompasses') return isSource ? 'covers' : 'covered_by'
  return 'confusable'
}

/** What the node panel shows for one concept of the student's course; null when it is not theirs or is gone. */
export async function getConceptPanel(userId: string, projectId: string, conceptId: string, now: Date = new Date()): Promise<ConceptPanel | null> {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, projectId, status: 'active', project: { userId } },
    select: {
      id: true,
      name: true,
      summary: true,
      kind: true,
      topicId: true,
      topic: { select: { name: true, unitId: true } },
      claims: {
        orderBy: { orderIndex: 'asc' },
        select: { id: true, text: true, materialId: true, pageStart: true, pageEnd: true, material: { select: { filename: true } } },
      },
    },
  })
  if (!concept) return null

  const [memory, events, edgeRows] = await Promise.all([
    prisma.conceptMemory.findUnique({ where: { userId_conceptId: { userId, conceptId } } }),
    prisma.evidenceEvent.findMany({
      // An instruction event is not an answer: every reader that counts answers leaves it out (spec 18.5).
      where: { userId, conceptId, source: { not: 'instruction' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PANEL_EVENTS,
      select: { id: true, source: true, score: true, assistance: true, createdAt: true },
    }),
    prisma.conceptEdge.findMany({
      where: { projectId, status: { not: 'rejected' }, OR: [{ sourceId: conceptId }, { targetId: conceptId }] },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sourceId: true, targetId: true, type: true, status: true, confidence: true },
    }),
  ])

  const shown = edgeRows.filter(showsOnMap)
  const otherIds = shown.map((edge) => (edge.sourceId === conceptId ? edge.targetId : edge.sourceId))
  const others = await prisma.concept.findMany({ where: { id: { in: otherIds }, projectId, status: 'active' }, select: { id: true, name: true } })
  const nameOf = new Map(others.map((other) => [other.id, other.name]))
  const links: PanelLink[] = shown.flatMap((edge) => {
    const isSource = edge.sourceId === conceptId
    const otherId = isSource ? edge.targetId : edge.sourceId
    const otherName = nameOf.get(otherId)
    return otherName === undefined
      ? []
      : [{ edgeId: edge.id, kind: linkKind(edge.type, isSource), status: edge.status as PanelLink['status'], otherId, otherName }]
  })

  const waiting = memory ? needsInstruction(stateFromMemoryRow(memory)) : false
  const help = waiting ? await helpAfterMiss(prisma, { userId, topicId: concept.topicId, conceptIds: [concept.id], surface: 'map' }) : null
  const state = memory
    ? conceptMastery(stateFromMemoryRow(memory), concept.kind as ConceptKind, now)
    : { label: 'not_started' as ConceptLabel, retrievability: 0 }
  return {
    id: concept.id,
    name: concept.name,
    summary: concept.summary,
    topicId: concept.topicId,
    topicName: concept.topic.name,
    unitId: concept.topic.unitId,
    label: state.label,
    retrievability: state.retrievability,
    dueAt: memory?.dueAt?.toISOString() ?? null,
    misconception: memory?.misconception ?? null,
    claims: concept.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      materialId: claim.materialId,
      filename: claim.material.filename,
      pageStart: claim.pageStart,
      pageEnd: claim.pageEnd,
    })),
    events: events.map((event) => ({ id: event.id, source: event.source, score: event.score, assisted: event.assistance >= 1, createdAt: event.createdAt.toISOString() })),
    links,
    needsInstruction: waiting,
    pointer: help?.pointers[0] ?? null,
    explainer: help?.explainer ?? null,
  }
}
