import { prisma } from '@/lib/db/prisma'
import { Prisma } from '@prisma/client'
import type { Card, Grade } from 'ts-fsrs'
import { conceptMastery, topicMasteryFromConcepts, type ConceptKind } from './concept-mastery'
import { emptyMemoryState, type ConceptMemoryState, type Mode } from './memory'
import {
  MASTERY_HISTORY,
  computeMasteryFromSignals,
  intervalFromMastery,
  isConfidenceFeedback,
  masteryFromHistory,
  newestPerTopic,
  type MasteryComponents,
} from './mastery-math'

export { computeMasteryFromSignals, intervalFromMastery, isConfidenceFeedback }
export type { MasteryComponents }

/** The database, or the transaction a caller is applying a result in. */
export type Db = Prisma.TransactionClient

export async function computeTopicMastery(
  userId: string,
  projectId: string,
  topicId: string,
  db: Db = prisma
): Promise<MasteryComponents> {
  const masteries = await computeProjectMastery(userId, projectId, [topicId], db)
  return masteries.get(topicId) as MasteryComponents
}

/**
 * Mastery for many topics of one project in a fixed number of queries, however many topics there are.
 * Each query fetches the user's recent rows for all the topics; the per-topic limits are
 * applied here.
 */
export async function computeProjectMastery(
  userId: string,
  projectId: string,
  topicIds: string[],
  db: Db = prisma
): Promise<Map<string, MasteryComponents>> {
  const result = new Map<string, MasteryComponents>()
  if (topicIds.length === 0) return result

  // One topic can be cut to its history length in SQL. With several, the rows are cut
  // per topic below.
  const limit = (history: number): number | undefined => (topicIds.length === 1 ? history : undefined)

  const now = Date.now()
  const [quizAttempts, voiceAttempts, examSignals, practiceSignals, conceptTopics] = await Promise.all([
    db.quizAttempt.findMany({
      where: { userId, topicId: { in: topicIds } },
      orderBy: { takenAt: 'desc' },
      take: limit(MASTERY_HISTORY.quiz),
      select: { topicId: true, score: true, takenAt: true },
    }),
    db.voiceDrillAttempt.findMany({
      where: { userId, topicId: { in: topicIds } },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.voice),
      select: { topicId: true, score: true, createdAt: true },
    }),
    db.learningSignal.findMany({
      where: { userId, projectId, topicId: { in: topicIds }, source: 'exam' },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.exam),
      select: { topicId: true, score: true, createdAt: true, metadata: true },
    }),
    db.learningSignal.findMany({
      where: { userId, projectId, topicId: { in: topicIds }, source: 'practice' },
      orderBy: { createdAt: 'desc' },
      take: limit(MASTERY_HISTORY.practice),
      select: { topicId: true, score: true, createdAt: true },
    }),
    conceptMasteryByTopic(db, userId, topicIds, new Date(now)),
  ])

  const quizByTopic = newestPerTopic(quizAttempts, MASTERY_HISTORY.quiz)
  const voiceByTopic = newestPerTopic(voiceAttempts, MASTERY_HISTORY.voice)
  const examByTopic = newestPerTopic(examSignals, MASTERY_HISTORY.exam)
  const practiceByTopic = newestPerTopic(practiceSignals, MASTERY_HISTORY.practice)

  for (const topicId of topicIds) {
    const legacy = masteryFromHistory({
      quiz: (quizByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.takenAt })),
      voice: (voiceByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.createdAt })),
      exam: (examByTopic.get(topicId) ?? [])
        .filter((row) => !isConfidenceFeedback(row.metadata))
        .map((row) => ({ score: row.score, at: row.createdAt })),
      practice: (practiceByTopic.get(topicId) ?? []).map((row) => ({ score: row.score, at: row.createdAt })),
      now,
    })
    // A topic with concepts takes its mastery from them (spec §3.6); the source breakdown stays the legacy one.
    const fromConcepts = conceptTopics.get(topicId)
    result.set(topicId, fromConcepts === undefined ? legacy : { ...legacy, mastery: fromConcepts })
  }
  return result
}

/**
 * Mastery of a topic's active concepts (spec §3.6): the mean of their concept mastery now, untouched
 * ones counting 0. Only topics whose history has been converted to evidence (Topic.evidenceBackfilledAt,
 * lib/learning/backfill.ts) are included: a topic with no active concepts (extraction failed or has not
 * run) and a topic with concepts that is still waiting for its backfill keep the legacy blend, so
 * history from before the concept graph is never shown as 0.
 */
async function conceptMasteryByTopic(db: Db, userId: string, topicIds: string[], now: Date): Promise<Map<string, number>> {
  const concepts = await db.concept.findMany({
    where: { topicId: { in: topicIds }, status: 'active', project: { userId }, topic: { evidenceBackfilledAt: { not: null } } },
    select: { id: true, topicId: true, kind: true },
  })
  const out = new Map<string, number>()
  if (concepts.length === 0) return out
  const rows = await db.conceptMemory.findMany({ where: { userId, conceptId: { in: concepts.map((c) => c.id) } } })
  const byConcept = new Map(rows.map((r) => [r.conceptId, r]))
  const byTopic = new Map<string, typeof concepts>()
  for (const concept of concepts) byTopic.set(concept.topicId, [...(byTopic.get(concept.topicId) ?? []), concept])
  for (const [topicId, list] of byTopic) out.set(topicId, topicMasteryOfConcepts(list, byConcept, now))
  return out
}

function topicMasteryOfConcepts(
  concepts: { id: string; kind: string }[],
  memory: Map<string, ConceptMemoryRow>,
  now: Date
): number {
  return topicMasteryFromConcepts(
    concepts.map((c) => {
      const row = memory.get(c.id)
      return { mastery: row ? conceptMastery(stateFromMemoryRow(row), c.kind as ConceptKind, now).mastery : 0 }
    })
  )
}

/** True when the topic's history is converted to evidence and it has active concepts: its memory is the concepts'. */
export async function isConverted(userId: string, topicId: string, db: Db = prisma): Promise<boolean> {
  return (
    (await db.concept.count({ where: { topicId, status: 'active', project: { userId }, topic: { evidenceBackfilledAt: { not: null } } } })) > 0
  )
}

/** Returns the schedule written, or for a converted topic the concepts' own row (null when it has none). */
export async function upsertReviewSchedule(input: {
  userId: string
  projectId: string
  topicId: string
  mastery: number
  wasCorrect?: boolean
  confidence?: number
  db?: Db
}) {
  const { userId, projectId, topicId, mastery, wasCorrect = true, confidence, db = prisma } = input
  // A converted topic's schedule is its concepts' (recomputeTopicFromConcepts, on every evidence write); the
  // interval-from-mastery rule below is for topics that have no concept memory yet, and must not overwrite it.
  if (await isConverted(userId, topicId, db)) {
    return db.reviewSchedule.findUnique({ where: { userId_topicId: { userId, topicId } } })
  }
  const intervalDays = intervalFromMastery(mastery, { wasCorrect, confidence })
  const now = new Date()
  const dueAt = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000)

  const existing = await db.reviewSchedule.findUnique({
    where: {
      userId_topicId: {
        userId,
        topicId,
      },
    },
    select: {
      streak: true,
    },
  })

  return db.reviewSchedule.upsert({
    where: {
      userId_topicId: {
        userId,
        topicId,
      },
    },
    update: {
      projectId,
      mastery,
      dueAt,
      intervalDays,
      streak: wasCorrect ? (existing?.streak || 0) + 1 : 0,
      lastReviewedAt: now,
    },
    create: {
      userId,
      projectId,
      topicId,
      mastery,
      dueAt,
      intervalDays,
      streak: wasCorrect ? 1 : 0,
      lastReviewedAt: now,
    },
  })
}

/**
 * Re-time a topic's next review after the student rates their confidence.
 *
 * Confidence is feedback, not practice: it never touches the streak or the last-reviewed
 * time, and it does not create a schedule for a topic nobody has practised. Low confidence
 * (1-2) brings the review forward to tomorrow; otherwise the usual mastery-based interval
 * applies, one step longer when confidence is high.
 */
export async function adjustReviewForConfidence(input: {
  userId: string
  topicId: string
  mastery: number
  confidence: number
}) {
  const { userId, topicId, mastery, confidence } = input
  const existing = await prisma.reviewSchedule.findUnique({
    where: { userId_topicId: { userId, topicId } },
    select: { lastReviewedAt: true },
  })
  if (!existing) return null

  const intervalDays = confidence <= 2 ? 1 : intervalFromMastery(mastery, { confidence })
  const base = existing.lastReviewedAt ?? new Date()
  return prisma.reviewSchedule.update({
    where: { userId_topicId: { userId, topicId } },
    data: {
      mastery,
      intervalDays,
      dueAt: new Date(base.getTime() + intervalDays * 24 * 60 * 60 * 1000),
    },
  })
}

export async function recordLearningSignal(input: {
  userId: string
  projectId: string
  topicId?: string | null
  source: 'quiz' | 'voice' | 'exam' | 'practice'
  score: number
  confidence?: number
  metadata?: Record<string, unknown>
  /** When it happened, if not now. */
  at?: Date
  db?: Db
}) {
  return (input.db ?? prisma).learningSignal.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId ?? null,
      source: input.source,
      score: input.score,
      confidence: input.confidence ?? null,
      metadata: (input.metadata ?? {}) as Prisma.JsonObject,
      ...(input.at ? { createdAt: input.at } : {}),
    },
  })
}

type ConceptMemoryRow = {
  card: Prisma.JsonValue | null
  dueAt: Date | null
  stability: number | null
  lastReviewAt: Date | null
  nUnassisted: number
  nAssisted: number
  lastEvidenceAt: Date | null
  lastAssistedAt: Date | null
  inferredPrior: number | null
  misconception: string | null
  misconceptionAt: Date | null
  consecutiveFails: number
  derived: Prisma.JsonValue
}

function reviveDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** The replay output as the JSON stored on `ConceptMemory.derived` (spec §3.1). */
export function derivedFromState(state: ConceptMemoryState): Prisma.InputJsonObject {
  return {
    firstEvidenceDay: state.firstEvidenceDay,
    itemKeysSeen: state.itemKeysSeen,
    delayedNewSuccess: state.delayedNewSuccess,
    explainedWell: state.explainedWell,
    modeReached: state.modeReached,
    lastMaxRung: state.lastMaxRung,
    lastMissKind: state.lastMissKind,
    lastFailAt: state.lastFailAt?.toISOString() ?? null,
    lastInstructionAt: state.lastInstructionAt?.toISOString() ?? null,
    lastIdkAt: state.lastIdkAt?.toISOString() ?? null,
    latestGrade: state.latestGrade,
    level0Scores: state.level0Scores.map((s) => ({ score: s.score, at: s.at.toISOString() })),
  }
}

/** Rebuilds the memory state from a stored row, so mastery can be recomputed at a later time. */
export function stateFromMemoryRow(row: ConceptMemoryRow): ConceptMemoryState {
  const derived = (row.derived && typeof row.derived === 'object' && !Array.isArray(row.derived)
    ? row.derived
    : {}) as Record<string, unknown>
  let card: Card | null = null
  if (row.card && typeof row.card === 'object' && !Array.isArray(row.card)) {
    const raw = row.card as Record<string, unknown>
    card = {
      ...raw,
      due: reviveDate(raw.due) ?? row.dueAt ?? new Date(),
      last_review: reviveDate(raw.last_review),
    } as unknown as Card
  }
  const scores = Array.isArray(derived.level0Scores) ? derived.level0Scores : []
  return {
    ...emptyMemoryState(),
    card,
    dueAt: row.dueAt,
    stability: row.stability,
    lastReviewAt: row.lastReviewAt,
    nUnassisted: row.nUnassisted,
    nAssisted: row.nAssisted,
    lastEvidenceAt: row.lastEvidenceAt,
    lastAssistedAt: row.lastAssistedAt,
    inferredPrior: row.inferredPrior,
    misconception: row.misconception,
    misconceptionAt: row.misconceptionAt,
    consecutiveFails: row.consecutiveFails,
    level0Scores: scores.flatMap((s: { score?: unknown; at?: unknown }) => {
      const at = reviveDate(s?.at)
      return typeof s?.score === 'number' && at ? [{ score: s.score, at }] : []
    }),
    firstEvidenceDay: typeof derived.firstEvidenceDay === 'string' ? derived.firstEvidenceDay : null,
    itemKeysSeen: Array.isArray(derived.itemKeysSeen) ? (derived.itemKeysSeen as string[]) : [],
    delayedNewSuccess: derived.delayedNewSuccess === true,
    explainedWell: derived.explainedWell === true,
    modeReached: (derived.modeReached as Mode) ?? 'recall',
    lastMaxRung: typeof derived.lastMaxRung === 'number' ? derived.lastMaxRung : null,
    lastMissKind: typeof derived.lastMissKind === 'string' ? derived.lastMissKind : null,
    // Rows written before v3.1 have none of these three; they read as never.
    lastFailAt: reviveDate(derived.lastFailAt) ?? null,
    lastInstructionAt: reviveDate(derived.lastInstructionAt) ?? null,
    lastIdkAt: reviveDate(derived.lastIdkAt) ?? null,
    latestGrade: typeof derived.latestGrade === 'number' && derived.latestGrade >= 1 && derived.latestGrade <= 4 ? (derived.latestGrade as Grade) : null,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Topic mastery from the topic's active concepts (spec §3.6), then the topic's ReviewSchedule:
 * dueAt is the earliest card due date, intervalDays is the gap from the latest review to it.
 * A topic with no concept cards leaves its schedule row untouched.
 */
export async function recomputeTopicFromConcepts(
  tx: Db,
  userId: string,
  topicId: string,
  now: Date = new Date()
): Promise<{ mastery: number; dueAt: Date | null }> {
  const concepts = await tx.concept.findMany({
    where: { topicId, status: 'active', project: { userId } },
    select: { id: true, kind: true, projectId: true },
  })
  const rows = await tx.conceptMemory.findMany({
    where: { userId, conceptId: { in: concepts.map((c) => c.id) } },
  })
  const byConcept = new Map(rows.map((r) => [r.conceptId, r]))
  // The same value the surfaces compute (computeProjectMastery): the concepts' once the topic's history is
  // converted, the legacy blend until then, so the stored schedule and the displayed mastery agree.
  const topic = await tx.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { evidenceBackfilledAt: true, projectId: true } })
  const converted = topic?.evidenceBackfilledAt
  const mastery =
    converted || !topic
      ? topicMasteryOfConcepts(concepts, byConcept, now)
      : ((await computeProjectMastery(userId, topic.projectId, [topicId], tx)).get(topicId)?.mastery ?? 0)

  const withCards = rows.filter((r) => r.dueAt !== null)
  if (withCards.length === 0 || concepts.length === 0) {
    // A converted topic whose evidence is all gone (a deleted quiz set, say) has nothing due; the row it had is stale.
    if (converted && concepts.length > 0) await tx.reviewSchedule.deleteMany({ where: { userId, topicId } })
    return { mastery, dueAt: null }
  }
  const dueAt = new Date(Math.min(...withCards.map((r) => r.dueAt!.getTime())))
  const reviews = withCards.flatMap((r) => (r.lastReviewAt ? [r.lastReviewAt.getTime()] : []))
  const lastReviewedAt = reviews.length > 0 ? new Date(Math.max(...reviews)) : null
  const intervalDays = lastReviewedAt
    ? Math.max(1, Math.round((dueAt.getTime() - lastReviewedAt.getTime()) / DAY_MS))
    : 1
  await tx.reviewSchedule.upsert({
    where: { userId_topicId: { userId, topicId } },
    update: { projectId: concepts[0].projectId, mastery, dueAt, intervalDays, lastReviewedAt },
    create: { userId, projectId: concepts[0].projectId, topicId, mastery, dueAt, intervalDays, streak: 0, lastReviewedAt },
  })
  return { mastery, dueAt }
}

/** True when the topic has active concepts, so concept mastery replaces the legacy blend. */
export async function hasConcepts(userId: string, topicId: string, db: Db = prisma): Promise<boolean> {
  return (await db.concept.count({ where: { topicId, status: 'active', project: { userId } } })) > 0
}
