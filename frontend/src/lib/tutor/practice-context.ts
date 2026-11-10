/**
 * What the course graph adds to a tutor request (spec §6.1, §6.2): the source claims of the step's
 * concepts, a prerequisite the student has let fade, and the concept this one is confused with.
 */

import { prisma } from '@/lib/db/prisma'
import { conceptMastery, type ConceptKind } from '@/lib/learning/concept-mastery'
import { stateFromMemoryRow } from '@/lib/learning/mastery'

/** A prerequisite counts as weak below this retrievability (spec §6.2, "back to the source"). */
export const WEAK_RETRIEVABILITY = 0.8
const MAX_CLAIMS = 4
const MAX_QUOTE_CHARS = 300
/** What the tutor reads of a related concept, and where it sits in the course. */
const CONCEPT_FIELDS = { id: true, name: true, summary: true, kind: true, status: true, orderIndex: true, topic: { select: { orderIndex: true } } } as const

export type PracticeContext = {
  claims: { text: string; quote: string; page?: number }[]
  weakPrerequisite?: { name: string; page?: number }
  confusable?: { name: string; summary: string }
}

/** The weakest of the prerequisites that have memory and are below the line; null when none is. */
export function pickWeakPrerequisite<T extends { retrievability: number | null }>(candidates: T[]): T | null {
  const weak = candidates.filter((item) => item.retrievability !== null && item.retrievability < WEAK_RETRIEVABILITY)
  if (weak.length === 0) return null
  return weak.reduce((worst, item) => ((item.retrievability as number) < (worst.retrievability as number) ? item : worst))
}

export async function loadPracticeContext(userId: string, projectId: string, conceptIds: string[], now = new Date()): Promise<PracticeContext> {
  if (conceptIds.length === 0) return { claims: [] }
  const active = await prisma.concept.findMany({
    where: { id: { in: conceptIds }, projectId, status: 'active', project: { userId } },
    select: { id: true },
  })
  // In the step's own order of its concepts: the database returns them in no set order, and their ids are random.
  const activeIds = new Set(active.map((concept) => concept.id))
  const ids = [...new Set(conceptIds)].filter((id) => activeIds.has(id))
  if (ids.length === 0) return { claims: [] }
  const place = (conceptId: string) => ids.indexOf(conceptId)

  const claimRows = await prisma.conceptClaim.findMany({
    where: { conceptId: { in: ids } },
    orderBy: { orderIndex: 'asc' },
    select: { conceptId: true, text: true, quote: true, pageStart: true },
  })
  const claims = claimRows
    .sort((a, b) => place(a.conceptId) - place(b.conceptId))
    .slice(0, MAX_CLAIMS)
    .map((claim) => ({
    text: claim.text,
    quote: claim.quote.slice(0, MAX_QUOTE_CHARS),
    ...(claim.pageStart !== null ? { page: claim.pageStart } : {}),
  }))

  const edges = await prisma.conceptEdge.findMany({
    where: {
      projectId,
      project: { userId },
      status: { not: 'rejected' },
      OR: [
        { type: 'prerequisite', targetId: { in: ids } },
        { type: 'confusable', OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }] },
      ],
    },
    select: {
      type: true,
      sourceId: true,
      targetId: true,
      confidence: true,
      source: { select: CONCEPT_FIELDS },
      target: { select: CONCEPT_FIELDS },
    },
  })
  // Most confident first; equal confidence in course order of the idea at the other end, so the same course names the same idea.
  const other = (edge: (typeof edges)[number]) => (ids.includes(edge.sourceId) ? edge.target : edge.source)
  edges.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      other(a).topic.orderIndex - other(b).topic.orderIndex ||
      other(a).orderIndex - other(b).orderIndex
  )

  const context: PracticeContext = { claims }

  const confusable = edges
    .filter((edge) => edge.type === 'confusable')
    .map((edge) => (ids.includes(edge.sourceId) ? edge.target : edge.source))
    .find((other) => other.status === 'active' && !ids.includes(other.id))
  if (confusable) context.confusable = { name: confusable.name, summary: confusable.summary }

  const prerequisites = edges
    .filter((edge) => edge.type === 'prerequisite' && edge.source.status === 'active' && !ids.includes(edge.sourceId))
    .map((edge) => edge.source)
  if (prerequisites.length > 0) {
    const memories = await prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: prerequisites.map((item) => item.id) } } })
    const byConcept = new Map(memories.map((row) => [row.conceptId, row]))
    const weak = pickWeakPrerequisite(
      prerequisites.map((item) => {
        const row = byConcept.get(item.id)
        return { ...item, retrievability: row ? conceptMastery(stateFromMemoryRow(row), item.kind as ConceptKind, now).retrievability : null }
      })
    )
    if (weak) {
      const page = await prisma.conceptClaim.findFirst({
        where: { conceptId: weak.id, pageStart: { not: null } },
        orderBy: { orderIndex: 'asc' },
        select: { pageStart: true },
      })
      context.weakPrerequisite = { name: weak.name, ...(page?.pageStart != null ? { page: page.pageStart } : {}) }
    }
  }
  return context
}
