import { prisma } from '@/lib/db/prisma'
import { conceptMastery, topicMasteryFromConcepts, type ConceptKind } from './concept-mastery'
import { displayMastery } from './mastery-math'
import { stateFromMemoryRow, type Db } from './mastery'

// The one place a topic's mastery and next review date are read from (spec §3.6): the quiz results, the topic
// header, the Topics list, the Overview, the Plan, Review and Home all take their figures from here, so no two
// screens can disagree.

const DAY_MS = 24 * 60 * 60 * 1000

export type TopicStanding = {
  /** Shown mastery, 0..1. Null until the topic has any signal. */
  mastery: number | null
  /** Mastery when it was last earned, before it faded for a late review (the concepts' own are already live). */
  earnedMastery: number | null
  dueAt: Date | null
  intervalDays: number | null
  lastReviewedAt: Date | null
}

const NONE: TopicStanding = { mastery: null, earnedMastery: null, dueAt: null, intervalDays: null, lastReviewedAt: null }

/**
 * A topic whose history is converted to evidence and that has active concepts takes both figures from its
 * concepts' memory, computed now: mastery is the mean of the concepts' mastery (untouched ones count 0) and
 * the due date is the earliest concept card due. Any other topic (no concepts yet, or waiting for its backfill)
 * keeps its ReviewSchedule row, mastery faded for a late review.
 */
export async function topicStandings(
  userId: string,
  topicIds: string[],
  now: Date = new Date(),
  db: Db = prisma
): Promise<Map<string, TopicStanding>> {
  const out = new Map<string, TopicStanding>()
  if (topicIds.length === 0) return out
  const [schedules, concepts] = await Promise.all([
    db.reviewSchedule.findMany({
      where: { userId, topicId: { in: topicIds } },
      select: { topicId: true, mastery: true, dueAt: true, intervalDays: true, lastReviewedAt: true },
    }),
    db.concept.findMany({
      where: { topicId: { in: topicIds }, status: 'active', topic: { evidenceBackfilledAt: { not: null } } },
      select: { id: true, topicId: true, kind: true },
    }),
  ])
  const scheduleByTopic = new Map(schedules.map((row) => [row.topicId, row]))
  const memory = concepts.length
    ? await db.conceptMemory.findMany({ where: { userId, conceptId: { in: concepts.map((c) => c.id) } } })
    : []
  const memoryByConcept = new Map(memory.map((row) => [row.conceptId, row]))
  const conceptsByTopic = new Map<string, typeof concepts>()
  for (const concept of concepts) conceptsByTopic.set(concept.topicId, [...(conceptsByTopic.get(concept.topicId) ?? []), concept])

  for (const topicId of topicIds) {
    const row = scheduleByTopic.get(topicId)
    const list = conceptsByTopic.get(topicId)
    if (!list) {
      out.set(
        topicId,
        row
          ? {
              mastery: displayMastery(row.mastery, row, now),
              earnedMastery: row.mastery,
              dueAt: row.dueAt,
              intervalDays: row.intervalDays,
              lastReviewedAt: row.lastReviewedAt,
            }
          : NONE
      )
      continue
    }
    const rows = list.flatMap((concept) => {
      const stored = memoryByConcept.get(concept.id)
      return stored ? [{ concept, stored }] : []
    })
    if (rows.length === 0) {
      out.set(topicId, NONE)
      continue
    }
    const mastery = topicMasteryFromConcepts(
      list.map((concept) => {
        const stored = memoryByConcept.get(concept.id)
        return { mastery: stored ? conceptMastery(stateFromMemoryRow(stored), concept.kind as ConceptKind, now).mastery : 0 }
      })
    )
    const withCards = rows.filter((r) => r.stored.dueAt !== null)
    const dueAt = withCards.length > 0 ? new Date(Math.min(...withCards.map((r) => r.stored.dueAt!.getTime()))) : null
    const reviews = withCards.flatMap((r) => (r.stored.lastReviewAt ? [r.stored.lastReviewAt.getTime()] : []))
    const lastReviewedAt = reviews.length > 0 ? new Date(Math.max(...reviews)) : null
    const intervalDays = dueAt ? (lastReviewedAt ? Math.max(1, Math.round((dueAt.getTime() - lastReviewedAt.getTime()) / DAY_MS)) : 1) : null
    out.set(topicId, { mastery, earnedMastery: Math.max(mastery, row?.mastery ?? 0), dueAt, intervalDays, lastReviewedAt })
  }
  return out
}

export async function topicStanding(userId: string, topicId: string, now: Date = new Date(), db: Db = prisma): Promise<TopicStanding> {
  return (await topicStandings(userId, [topicId], now, db)).get(topicId) ?? NONE
}
