import { Prisma } from '@prisma/client'
import { Rating } from 'ts-fsrs'
import { prisma } from '@/lib/db/prisma'
import type { Assistance, ConceptEvent, EventRow, EvidenceSource, GradedBy, ItemAnswerInput } from './evidence-types'
import { expandToConceptEvents } from './item-key'
import { implicitEventsFor, usable, type EdgeRow } from './fire'
import { conceptMastery, type ConceptKind } from './concept-mastery'
import { gradeEventGroup, replayConcept } from './memory'
import { derivedFromState, hasConcepts, recomputeTopicFromConcepts, type Db } from './mastery'
import { withTransactionRetry } from './transaction-retry'

export { hasConcepts }

// The only writer of learner-model evidence (spec §3.4, D3 and D4 in §16).

type Touched = { topicId: string; mastery: number; dueAt: Date | null }
type RecordOptions = {
  // Events with these session keys are deleted and replaced (a regrade, a deleted quiz set).
  replaceSessionKeys?: string[]
  // The student's IANA zone, for the one-FSRS-review-per-local-day collapse.
  timeZone?: string
  // Needed only when replacing events with no new inputs.
  userId?: string
  // Drop, inside the lock, answers that already have events: the same item under the same session
  // key, or (practice and voice, whose item keys belong to one answer) the same item key. For writers
  // that read what exists before they write (the backfill, a voice answer), so a concurrent writer
  // of the same answer cannot make it count twice.
  skipIfPresent?: boolean
  // Runs inside the same transaction, after the events are written and before the replay (a practice save
  // stores its row here, so the row and the evidence of its steps change together or not at all). It may run
  // again if the transaction is retried after a deadlock, so it must be safe to repeat.
  inTransaction?: (tx: Db) => Promise<void>
  // Checked inside the transaction once the concepts are locked: when it answers false nothing is written. A
  // writer that must not repeat itself (a double-clicked button) asks here, so two of them take turns on the
  // concept locks and the second sees the first's commit, on one connection.
  onlyIf?: (tx: Db) => Promise<boolean>
}

function pathEdgeIdsOf(metadata: Record<string, unknown>): string[] {
  const ids = metadata.pathEdgeIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

const IMPLICIT_OFFSET_MS = 1
const TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 }

function metadataObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** A stored event as replay reads it: item key, grader and metadata all pass through. */
function toEventRow(row: {
  source: string
  score: number
  assistance: number
  confidence: number | null
  weight: number
  sessionKey: string
  createdAt: Date
  metadata: Prisma.JsonValue
  itemKey: string
  gradedBy: string
}): EventRow {
  return {
    source: row.source as EvidenceSource,
    score: row.score,
    assistance: row.assistance as Assistance,
    confidence: row.confidence,
    weight: row.weight,
    sessionKey: row.sessionKey,
    createdAt: row.createdAt,
    metadata: metadataObject(row.metadata),
    itemKey: row.itemKey,
    gradedBy: row.gradedBy as GradedBy,
  }
}

/**
 * Serialises writers of the same (user, concept); sorted order keeps two writers from deadlocking.
 * Re-taking a lock this transaction already holds is a no-op.
 */
async function lockConcepts(tx: Db, userId: string, conceptIds: Iterable<string>): Promise<void> {
  for (const conceptId of [...new Set(conceptIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${conceptId}`}, 0))`
  }
}

// Per-(user, topic) locks guard the topic recompute and its ReviewSchedule row, which writers of
// different concepts in one topic share. Always taken after the concept locks, in sorted order.
async function lockTopics(tx: Db, userId: string, topicIds: Iterable<string>): Promise<void> {
  for (const topicId of [...new Set(topicIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:topic:${topicId}`}, 0))`
  }
}

// Locks the concepts, plus any a replaced session key reaches that were not known before the
// lock was held, until the set is stable; then the topics of all of them. Returns the locked set.
async function lockForWrite(tx: Db, userId: string, conceptIds: Set<string>, replaceKeys: string[]) {
  const locked = new Set(conceptIds)
  for (;;) {
    await lockConcepts(tx, userId, locked)
    if (replaceKeys.length === 0) break
    const now = await tx.evidenceEvent.findMany({
      where: { userId, sessionKey: { in: replaceKeys } },
      select: { conceptId: true },
      distinct: ['conceptId'],
    })
    const grown = now.filter((r) => !locked.has(r.conceptId))
    if (grown.length === 0) break
    for (const r of grown) locked.add(r.conceptId)
  }
  const concepts = await tx.concept.findMany({ where: { id: { in: [...locked] } }, select: { topicId: true } })
  await lockTopics(tx, userId, concepts.map((c) => c.topicId))
  return locked
}

function toInsert(event: ConceptEvent): Prisma.EvidenceEventCreateManyInput {
  return {
    userId: event.userId,
    projectId: event.projectId,
    topicId: event.topicId,
    conceptId: event.conceptId,
    itemKey: event.itemKey,
    source: event.source,
    score: event.score,
    assistance: event.assistance,
    confidence: event.confidence,
    weight: event.weight,
    role: event.role,
    gradedBy: event.gradedBy,
    latencyMs: event.latencyMs,
    sessionKey: event.sessionKey,
    metadata: event.metadata as Prisma.InputJsonObject,
    createdAt: event.createdAt,
  }
}

// The rating each (concept, session) group earns, grouped and graded exactly as replay does
// (assisted-at-2-or-more and warm-up events are not part of a review group).
function ratingsByGroup(events: ConceptEvent[]): { head: ConceptEvent; rating: Rating; at: Date }[] {
  const groups = new Map<string, ConceptEvent[]>()
  for (const event of events) {
    if (event.source === 'warmup' || event.source === 'implicit' || event.source === 'instruction' || event.assistance >= 2) continue
    const key = `${event.conceptId}\u0000${event.sessionKey}`
    groups.set(key, [...(groups.get(key) ?? []), event])
  }
  return [...groups.values()].map((group) => ({
    head: group[0],
    rating: gradeEventGroup(group).grade,
    at: new Date(Math.max(...group.map((e) => e.createdAt.getTime()))),
  }))
}

async function replayAndStore(
  tx: Db,
  userId: string,
  conceptIds: string[],
  now: Date,
  timeZone: string
): Promise<Touched[]> {
  const concepts = await tx.concept.findMany({
    where: { id: { in: conceptIds } },
    select: { id: true, projectId: true, topicId: true, kind: true },
  })
  const events = await tx.evidenceEvent.findMany({
    where: { userId, conceptId: { in: conceptIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const byConcept = new Map<string, EventRow[]>()
  for (const row of events) {
    byConcept.set(row.conceptId, [...(byConcept.get(row.conceptId) ?? []), toEventRow(row)])
  }

  const topicIds = new Set<string>()
  for (const concept of concepts) {
    const state = replayConcept(byConcept.get(concept.id) ?? [], { timeZone, now })
    const { mastery, label } = conceptMastery(state, concept.kind as ConceptKind, now)
    const data = {
      projectId: concept.projectId,
      topicId: concept.topicId,
      card: state.card ? (JSON.parse(JSON.stringify(state.card)) as Prisma.InputJsonObject) : Prisma.DbNull,
      dueAt: state.dueAt,
      stability: state.stability,
      lastReviewAt: state.lastReviewAt,
      nUnassisted: state.nUnassisted,
      nAssisted: state.nAssisted,
      lastEvidenceAt: state.lastEvidenceAt,
      lastAssistedAt: state.lastAssistedAt,
      inferredPrior: state.inferredPrior,
      misconception: state.misconception,
      misconceptionAt: state.misconceptionAt,
      consecutiveFails: state.consecutiveFails,
      mastery,
      label,
      derived: derivedFromState(state),
    }
    await tx.conceptMemory.upsert({
      where: { userId_conceptId: { userId, conceptId: concept.id } },
      update: data,
      create: { userId, conceptId: concept.id, ...data },
    })
    topicIds.add(concept.topicId)
  }

  const topics: Touched[] = []
  for (const topicId of [...topicIds].sort()) {
    topics.push({ topicId, ...(await recomputeTopicFromConcepts(tx, userId, topicId, now)) })
  }
  return topics
}

/**
 * Writes graded answers as evidence events and rebuilds the memory of every concept they touch,
 * including concepts credited or penalised through encompasses edges. One transaction.
 */
export function recordEvidence(
  inputs: ItemAnswerInput[],
  opts: RecordOptions = {}
): Promise<{ topics: Touched[] }> {
  // A replaced session can reach concepts that are locked late, out of sorted order, so two
  // double-submitted regrades may deadlock (40P01); the loser runs again from the start.
  return withTransactionRetry(() => recordEvidenceOnce(inputs, opts))
}

async function recordEvidenceOnce(
  inputs: ItemAnswerInput[],
  opts: RecordOptions
): Promise<{ topics: Touched[] }> {
  const replaceKeys = opts.replaceSessionKeys ?? []
  const userIds = [...new Set(inputs.map((i) => i.userId))]
  if (userIds.length > 1) throw new Error('recordEvidence takes one user per call')
  const userId = userIds[0] ?? opts.userId
  if (!userId || (inputs.length === 0 && replaceKeys.length === 0)) return { topics: [] }
  const timeZone = opts.timeZone ?? 'UTC'
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    const allDirect = inputs.flatMap(expandToConceptEvents)

    // The concepts the replaced events touched, so they are replayed after the swap.
    const replaced =
      replaceKeys.length > 0
        ? await tx.evidenceEvent.findMany({
            where: { userId, sessionKey: { in: replaceKeys } },
            select: { conceptId: true },
          })
        : []

    // Implicit credit and penalty along the encompasses edges follow the rating of a whole (concept, session)
    // group, not of one save: a session saved in several writes must credit a target once, not once per save.
    // Which way a group will rate is only known once its stored events are read under the lock, so the
    // concepts either rating could reach are locked up front, in sorted order.
    const projectIds = [...new Set(allDirect.map((e) => e.projectId))]
    const edgesByProject = new Map<string, EdgeRow[]>()
    if (projectIds.length > 0) {
      const edges = await tx.conceptEdge.findMany({
        where: { projectId: { in: projectIds }, type: 'encompasses', status: { in: ['confirmed', 'proposed'] } },
      })
      for (const edge of edges) {
        edgesByProject.set(edge.projectId, [...(edgesByProject.get(edge.projectId) ?? []), edge])
      }
    }
    const reachable = new Set<string>()
    // An instruction event is not an answer: it spreads no credit and no penalty, so it reaches no other concept.
    for (const head of new Map(allDirect.filter((e) => e.source !== 'instruction').map((e) => [e.conceptId, e])).values()) {
      for (const rating of [Rating.Good, Rating.Again]) {
        for (const target of implicitEventsFor(head.conceptId, rating, edgesByProject.get(head.projectId) ?? [])) reachable.add(target.targetId)
      }
    }
    const targetConcepts = await tx.concept.findMany({
      where: { id: { in: [...reachable] }, status: 'active' },
      select: { id: true, projectId: true, topicId: true },
    })
    const targetById = new Map(targetConcepts.map((c) => [c.id, c]))

    let direct = allDirect
    const touched = new Set([...replaced.map((r) => r.conceptId), ...allDirect.map((e) => e.conceptId), ...targetById.keys()])
    const locked = await lockForWrite(tx, userId, touched, replaceKeys)
    if (opts.onlyIf && !(await opts.onlyIf(tx))) return { topics: [] }

    if (opts.skipIfPresent && allDirect.length > 0) {
      const present = await tx.evidenceEvent.findMany({
        where: { userId, itemKey: { in: [...new Set(allDirect.map((e) => e.itemKey))] }, source: { not: 'implicit' } },
        select: { itemKey: true, sessionKey: true },
      })
      const sessionOf = new Map<string, Set<string>>()
      for (const row of present) sessionOf.set(row.itemKey, (sessionOf.get(row.itemKey) ?? new Set()).add(row.sessionKey))
      direct = allDirect.filter((e) => {
        const sessions = sessionOf.get(e.itemKey)
        return !(!!sessions && (e.source === 'practice' || e.source === 'voice' || sessions.has(e.sessionKey)))
      })
    }

    // The groups this write changes, graded with the events they already hold (those a replace deletes do not count).
    const groupKeys = [...new Set(direct.map((e) => e.sessionKey))]
    const stored =
      direct.length > 0
        ? await tx.evidenceEvent.findMany({
            where: {
              userId,
              conceptId: { in: [...new Set(direct.map((e) => e.conceptId))] },
              sessionKey: { in: groupKeys.filter((k) => !replaceKeys.includes(k)) },
              source: { notIn: ['implicit', 'warmup'] },
            },
          })
        : []
    const headOf = new Map(direct.map((e) => [e.conceptId, e]))
    const prior: ConceptEvent[] = stored.map((row) => ({
      ...toEventRow(row),
      userId,
      projectId: headOf.get(row.conceptId)!.projectId,
      topicId: row.topicId,
      conceptId: row.conceptId,
      itemKey: row.itemKey,
      role: row.role as 'primary' | 'secondary',
      gradedBy: row.gradedBy as GradedBy,
      latencyMs: row.latencyMs,
    }))
    const groups = ratingsByGroup([...prior, ...direct])
    const changed = new Set(direct.map((e) => `${e.conceptId}\u0000${e.sessionKey}`))
    const drafts = groups
      .filter(({ head }) => changed.has(`${head.conceptId}\u0000${head.sessionKey}`))
      .flatMap(({ head, rating, at }) =>
        implicitEventsFor(head.conceptId, rating, edgesByProject.get(head.projectId) ?? []).map((target) => ({ head, target, at }))
      )
    const allImplicit: ConceptEvent[] = drafts.flatMap(({ head, target, at }) => {
      const concept = targetById.get(target.targetId)
      if (!concept || concept.projectId !== head.projectId) return []
      return [
        {
          userId,
          projectId: concept.projectId,
          topicId: concept.topicId,
          conceptId: concept.id,
          itemKey: head.itemKey,
          role: 'secondary' as const,
          source: 'implicit' as const,
          score: target.direction === 'credit' ? 1 : 0,
          assistance: 0 as const,
          confidence: null,
          weight: target.pathWeight,
          gradedBy: 'rule' as const,
          latencyMs: null,
          sessionKey: head.sessionKey,
          metadata: { direction: target.direction, pathWeight: target.pathWeight, edgeId: target.edgeId, pathEdgeIds: target.pathEdgeIds, sourceConceptId: head.conceptId },
          createdAt: new Date(at.getTime() + IMPLICIT_OFFSET_MS),
        },
      ]
    })

    // The links are read again now that the concepts are locked, and held (FOR SHARE) until this write commits: a link the
    // student rejected while this answer was being worked out gives no credit, and a rejection that arrives next waits
    // for this write and then removes what it wrote (lib/learning/concept-edge.ts).
    let implicit = allImplicit
    const walked = [...new Set(allImplicit.flatMap((e) => pathEdgeIdsOf(e.metadata)))]
    if (walked.length > 0) {
      const rows = await tx.$queryRaw<{ id: string; type: string; status: string; confidence: number }[]>`SELECT id, type, status, confidence FROM concept_edges WHERE id IN (${Prisma.join(walked)}) FOR SHARE`
      const live = new Set(rows.filter((row) => usable(row)).map((row) => row.id))
      implicit = allImplicit.filter((e) => pathEdgeIdsOf(e.metadata).every((id) => live.has(id)))
    }

    // What an earlier save of these groups credited is replaced by what the whole group earns now.
    for (const key of changed) {
      const [conceptId, sessionKey] = key.split('\u0000')
      await tx.evidenceEvent.deleteMany({
        where: { userId, source: 'implicit', sessionKey, metadata: { path: ['sourceConceptId'], equals: conceptId } },
      })
    }

    if (replaceKeys.length > 0) {
      await tx.evidenceEvent.deleteMany({
        where: { userId, sessionKey: { in: replaceKeys }, conceptId: { in: [...locked] } },
      })
    }
    if (direct.length + implicit.length > 0) {
      await tx.evidenceEvent.createMany({ data: [...direct, ...implicit].map(toInsert) })
    }
    await opts.inTransaction?.(tx)
    return { topics: await replayAndStore(tx, userId, [...locked], now, timeZone) }
  }, TX_OPTIONS)
}

/** Replays the named concepts from their events (after an edge change, say) and refreshes their topics. */
export async function rebuildConcepts(
  userId: string,
  conceptIds: string[],
  timeZone: string,
  // Runs inside the same transaction, after the locks and before the replay (the backfill marks its topics here,
  // so the marker and the schedule that follows it change together or not at all).
  beforeReplay?: (tx: Db) => Promise<void>
): Promise<void> {
  if (conceptIds.length === 0) return
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const locked = await lockForWrite(tx, userId, new Set(conceptIds), [])
      await beforeReplay?.(tx)
      await replayAndStore(tx, userId, [...locked], new Date(), timeZone)
    }, TX_OPTIONS)
  )
}
