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
    where: { id: { in: conceptIds }, projectId, status: 'active' },
    select: { id: true },
  })
  const ids = active.map((concept) => concept.id)
  if (ids.length === 0) return { claims: [] }

  const claimRows = await prisma.conceptClaim.findMany({
    where: { conceptId: { in: ids } },
    orderBy: [{ conceptId: 'asc' }, { orderIndex: 'asc' }],
    take: MAX_CLAIMS,
    select: { text: true, quote: true, pageStart: true },
  })
  const claims = claimRows.map((claim) => ({
    text: claim.text,
    quote: claim.quote.slice(0, MAX_QUOTE_CHARS),
    ...(claim.pageStart !== null ? { page: claim.pageStart } : {}),
  }))

  const edges = await prisma.conceptEdge.findMany({
    where: {
      projectId,
      status: { not: 'rejected' },
      OR: [
        { type: 'prerequisite', targetId: { in: ids } },
        { type: 'confusable', OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }] },
      ],
    },
    orderBy: { confidence: 'desc' },
    select: {
      type: true,
      sourceId: true,
      targetId: true,
      source: { select: { id: true, name: true, summary: true, kind: true, status: true } },
      target: { select: { id: true, name: true, summary: true, kind: true, status: true } },
    },
  })

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
