/**
 * Which concepts a review session draws from (spec §7.4). Pure: the database reads are in
 * review-bank.ts. A concept is due when its next review falls before the end of the student's today or
 * its retrievability is under 0.9, and also when a practice step on it was surrendered on an earlier day
 * and has not been answered unaided since: the worked example was shown, so the idea comes back the next
 * day in a fresh item (spec §6.2, §7.4).
 */

import { dueBoundary } from './next-step'
import type { BandInputs } from './level'
import type { Mode, DueConcept } from './review-select'
import { toMissKind, toRung } from './review-select'

/** Due when retrievability has fallen under this (the retention FSRS aims at). */
export const DUE_RETRIEVABILITY = 0.9

/** The fields of an evidence event the surrender rule reads. */
export type EvidenceFact = {
  conceptId: string
  itemKey: string
  createdAt: Date
  source: string
  assistance: number
  /** `metadata.surrendered`: the student asked for the worked example (practice events). */
  surrendered: boolean
}

/** A concept's stored memory, reduced to what the due rule and the item choice read. */
export type MemorySummary = {
  conceptId: string
  topicId: string
  /** The concept has an FSRS card: it has been answered unaided at least once. */
  hasCard: boolean
  dueAt: Date | null
  retrievability: number
  mastery: number
  misconception: boolean
  modeReached: Mode
  lastMaxRung: number | null
  lastMissKind: string | null
  /** What `conceptBand` reads (lib/learning/level.ts), so a review item aims at the same support level as everything else. */
  bandInputs: BandInputs
}

// A warm-up guess and an implicit credit are not the student answering the idea unaided.
const NOT_A_RETEST = new Set(['warmup', 'implicit'])

/**
 * The concepts with a surrendered step still to come back, each with when it falls due: the start of the
 * local day after the earliest such surrender. Surrender and finish events of one step share an item key,
 * so a step counts once. A level-0 answer after a surrender settles it, and nothing is due before the
 * day after.
 */
export function surrenderedDue(facts: EvidenceFact[], now: Date, timeZone: string): Map<string, Date> {
  const byConcept = new Map<string, EvidenceFact[]>()
  for (const fact of facts) byConcept.set(fact.conceptId, [...(byConcept.get(fact.conceptId) ?? []), fact])

  const result = new Map<string, Date>()
  for (const [conceptId, events] of byConcept) {
    const lastUnaided = Math.max(
      -Infinity,
      ...events.filter((e) => e.assistance === 0 && !NOT_A_RETEST.has(e.source)).map((e) => e.createdAt.getTime())
    )
    const firstByStep = new Map<string, Date>()
    for (const event of events) {
      if (!event.surrendered || event.createdAt.getTime() <= lastUnaided) continue
      const seen = firstByStep.get(event.itemKey)
      if (!seen || event.createdAt < seen) firstByStep.set(event.itemKey, event.createdAt)
    }
    if (firstByStep.size === 0) continue
    const earliest = new Date(Math.min(...[...firstByStep.values()].map((d) => d.getTime())))
    // The start of the local day after the surrender.
    const from = dueBoundary(earliest, timeZone)
    if (from.getTime() <= now.getTime()) result.set(conceptId, from)
  }
  return result
}

/**
 * The due concepts as `selectReviewItems` reads them. `surrendered` is the output of `surrenderedDue`;
 * `confusableOf` names a concept's near-twin, when it has one.
 */
export function dueConcepts(input: {
  memories: MemorySummary[]
  surrendered: Map<string, Date>
  confusableOf: (conceptId: string) => string | undefined
  now: Date
  timeZone: string
}): DueConcept[] {
  const { now, timeZone } = input
  const boundary = dueBoundary(now, timeZone).getTime()
  const due: DueConcept[] = []
  for (const memory of input.memories) {
    const surrenderedFrom = input.surrendered.get(memory.conceptId)
    const scheduled =
      memory.hasCard &&
      memory.dueAt !== null &&
      (memory.dueAt.getTime() < boundary || memory.retrievability < DUE_RETRIEVABILITY)
    if (!scheduled && !surrenderedFrom) continue
    // Whichever fell due first.
    const dueAt =
      scheduled && memory.dueAt && (!surrenderedFrom || memory.dueAt < surrenderedFrom)
        ? memory.dueAt
        : (surrenderedFrom as Date)
    const missKind = toMissKind(memory.lastMissKind)
    const confusableId = input.confusableOf(memory.conceptId)
    due.push({
      conceptId: memory.conceptId,
      topicId: memory.topicId,
      misconception: memory.misconception,
      dueAt,
      retrievability: memory.retrievability,
      mastery: memory.mastery,
      lastMaxRung: toRung(memory.lastMaxRung),
      bandInputs: memory.bandInputs,
      modeReached: memory.modeReached,
      ...(missKind ? { lastMissKind: missKind } : {}),
      ...(confusableId ? { confusableId } : {}),
    })
  }
  return due
}
