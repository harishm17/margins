/**
 * The support band of the concepts a tutor conversation is about (spec 18.6). Ask, the reader and voice all read
 * their thresholds from it, so no tutor keeps a rule of its own: this loads each concept's replay, calls
 * `conceptBand` and reduces to the lowest band, because the student who needs the most support sets the pace.
 */

import { prisma } from '@/lib/db/prisma'
import { conceptMastery, type ConceptKind } from '@/lib/learning/concept-mastery'
import { UNKNOWN_BAND_INPUTS, bandInputsFromState, conceptBand, type Band } from '@/lib/learning/level'
import { stateFromMemoryRow } from '@/lib/learning/mastery'
import { warmupPriorByConcept } from '@/lib/learning/warmup-bracket'
import { latestWarmupResults } from '@/lib/learning/warmup-session'

/** The band of each of the student's own active concepts among `conceptIds`. Concepts that are not theirs are left out. */
export async function conceptBandsFor(userId: string, conceptIds: readonly string[], now: Date = new Date()): Promise<Map<string, Band>> {
  const out = new Map<string, Band>()
  if (conceptIds.length === 0) return out
  const concepts = await prisma.concept.findMany({
    where: { id: { in: [...conceptIds] }, status: 'active', project: { userId } },
    select: { id: true, kind: true, topicId: true },
  })
  if (concepts.length === 0) return out
  const memories = await prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: concepts.map((c) => c.id) } } })
  const memoryOf = new Map(memories.map((row) => [row.conceptId, row]))
  const priors = new Map<string, number>()
  for (const topicId of new Set(concepts.map((c) => c.topicId))) {
    const results = await latestWarmupResults(userId, topicId)
    for (const [id, value] of warmupPriorByConcept(results ?? [])) priors.set(id, value)
  }
  for (const concept of concepts) {
    const prior = priors.get(concept.id) ?? null
    const row = memoryOf.get(concept.id)
    if (!row) {
      out.set(concept.id, conceptBand({ ...UNKNOWN_BAND_INPUTS, prior }))
      continue
    }
    const state = stateFromMemoryRow(row)
    const { retrievability } = conceptMastery(state, concept.kind as ConceptKind, now)
    out.set(concept.id, conceptBand(bandInputsFromState(state, retrievability, prior)))
  }
  return out
}

/** The lowest band among the concepts (the one that needs the most support); band 0 when none is known (spec 18.6: unknown starts with support). */
export async function lowestBand(userId: string, conceptIds: readonly string[], now: Date = new Date()): Promise<Band> {
  const bands = [...(await conceptBandsFor(userId, conceptIds, now)).values()]
  return bands.length === 0 ? 0 : (Math.min(...bands) as Band)
}
