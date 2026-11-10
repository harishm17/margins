/**
 * What a review session reads from the database (spec §7.4): the due concepts with their memory, and the
 * bank of items to serve. The choices themselves are pure (review-select.ts, drill-select.ts).
 *
 * The bank is the topic's quiz sets and the retry sets copied from them, plus the review bank the
 * review-item job appends to (`topic_quizzes kind='review_bank'`). Only items that name concepts can be
 * served. A question that appears in two sets (a retry copy) is one item. The warm-up bank is never read.
 */

import { prisma } from '@/lib/db/prisma'
import { conceptMastery, type ConceptKind } from './concept-mastery'
import { dueConcepts, surrenderedDue, type EvidenceFact, type MemorySummary } from './due-concepts'
import { pickWeakestPrerequisite } from './drill-select'
import { itemKey } from './item-key'
import { UNKNOWN_BAND_INPUTS, bandInputsFromState } from './level'
import { stateFromMemoryRow } from './mastery'
import { toMissKind, toRung, type BankItem, type Difficulty, type DueConcept, type Mode } from './review-select'

type RawQuestion = Record<string, unknown>

/** An item as stored, for serving: the full question (with its answer key) and where it lives. */
export type StoredItem = { bankId: string; index: number; question: RawQuestion }

export type ConceptInfo = { id: string; name: string; topicId: string; kind: string }

export type ReviewContext = {
  /** Every active concept of the course's confirmed topics. */
  concepts: Map<string, ConceptInfo>
  topicNames: Map<string, string>
  memories: Map<string, MemorySummary>
  due: DueConcept[]
  bank: BankItem[]
  stored: Map<string, StoredItem>
  /** Each concept's near-twin, when it has one. */
  confusable: Map<string, string>
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']
const MODES: Mode[] = ['recall', 'discrimination', 'composition']
// A proposed link counts at this confidence or above (the link job's floor, ai-service MIN_LINK_CONFIDENCE).
const LINK_CONFIDENCE = 0.6

const isRecord = (value: unknown): value is RawQuestion => !!value && typeof value === 'object' && !Array.isArray(value)

const textKey = (question: RawQuestion) => String(question.question_text ?? '').toLowerCase().split(/\s+/).join(' ').trim()

const KIND_ORDER: Record<string, number> = { standard: 0, retry: 1, review_bank: 2 }

/** The servable items of the topics, and their full questions. */
export async function loadBank(
  userId: string,
  topicIds: string[],
  activeConceptIds: Set<string>
): Promise<{ bank: BankItem[]; stored: Map<string, StoredItem> }> {
  if (topicIds.length === 0) return { bank: [], stored: new Map() }
  const rows = await prisma.topicQuiz.findMany({
    where: { topicId: { in: topicIds }, kind: { in: ['standard', 'retry', 'review_bank'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, topicId: true, kind: true, questions: true },
  })
  rows.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))

  // The first copy of a question is the item; its twins only tell when it was last answered.
  const byText = new Map<string, { primary: string; keys: string[] }>()
  const items: BankItem[] = []
  const stored = new Map<string, StoredItem>()
  for (const row of rows) {
    if (!Array.isArray(row.questions)) continue
    row.questions.forEach((raw, index) => {
      if (!isRecord(raw)) return
      const conceptIds = (Array.isArray(raw.concept_ids) ? raw.concept_ids : []).filter(
        (id): id is string => typeof id === 'string' && activeConceptIds.has(id)
      )
      if (conceptIds.length === 0) return
      const key = itemKey({ kind: 'quiz', setId: row.id, index })
      const text = textKey(raw)
      const seen = byText.get(text)
      if (seen) {
        seen.keys.push(key)
        return
      }
      byText.set(text, { primary: key, keys: [key] })
      const difficulty = DIFFICULTIES.includes(raw.difficulty as Difficulty) ? (raw.difficulty as Difficulty) : 'medium'
      const mode = MODES.includes(raw.mode as Mode) ? (raw.mode as Mode) : 'recall'
      items.push({ itemKey: key, conceptIds, difficulty, mode, topicId: row.topicId, lastAnsweredAt: null })
      stored.set(key, { bankId: row.id, index, question: raw })
    })
  }

  // When each item (any of its copies) was last answered: events of any source on its key, not implicit credit.
  const allKeys = [...byText.values()].flatMap((entry) => entry.keys)
  const last = allKeys.length
    ? await prisma.evidenceEvent.groupBy({
        by: ['itemKey'],
        where: { userId, itemKey: { in: allKeys }, source: { not: 'implicit' } },
        _max: { createdAt: true },
      })
    : []
  const lastByKey = new Map(last.map((row) => [row.itemKey, row._max.createdAt]))
  const lastAnswered = (keys: string[]) =>
    keys.reduce<Date | null>((latest, key) => {
      const at = lastByKey.get(key) ?? null
      return at && (!latest || at > latest) ? at : latest
    }, null)
  const keysOf = new Map([...byText.values()].map((entry) => [entry.primary, entry.keys]))
  for (const item of items) item.lastAnsweredAt = lastAnswered(keysOf.get(item.itemKey) ?? [item.itemKey])
  return { bank: items, stored }
}

/** Facts about the surrendered steps' concepts, for the "come back the next day" rule. */
async function loadSurrenderFacts(userId: string, projectId: string): Promise<EvidenceFact[]> {
  const surrendered = await prisma.evidenceEvent.findMany({
    where: { userId, projectId, source: 'practice', assistance: 3, metadata: { path: ['surrendered'], equals: true } },
    distinct: ['conceptId'],
    select: { conceptId: true },
  })
  if (surrendered.length === 0) return []
  const events = await prisma.evidenceEvent.findMany({
    where: { userId, projectId, conceptId: { in: surrendered.map((row) => row.conceptId) }, source: { not: 'implicit' } },
    select: { conceptId: true, itemKey: true, createdAt: true, source: true, assistance: true, metadata: true },
  })
  return events.map((event) => ({
    conceptId: event.conceptId,
    itemKey: event.itemKey,
    createdAt: event.createdAt,
    source: event.source,
    assistance: event.assistance,
    surrendered: isRecord(event.metadata) && event.metadata.surrendered === true,
  }))
}

function summarise(row: Awaited<ReturnType<typeof prisma.conceptMemory.findMany>>[number], kind: string, now: Date): MemorySummary {
  const state = stateFromMemoryRow(row)
  const { mastery, retrievability } = conceptMastery(state, kind as ConceptKind, now)
  return {
    conceptId: row.conceptId,
    topicId: row.topicId,
    hasCard: state.card !== null,
    dueAt: row.dueAt,
    retrievability,
    mastery,
    misconception: !!row.misconception,
    modeReached: state.modeReached,
    lastMaxRung: state.lastMaxRung,
    lastMissKind: state.lastMissKind,
    // The warm-up prior only matters before any evidence, and a review item is for a concept already answered.
    bandInputs: bandInputsFromState(state, retrievability, null),
  }
}

/** Everything a selection needs for one course. */
export async function loadReviewContext(input: {
  userId: string
  projectId: string
  now: Date
  timeZone: string
  /** False for a caller that only counts what is due (the Review page): the item bank is not read. */
  withBank?: boolean
}): Promise<ReviewContext> {
  const { userId, projectId, now, timeZone } = input
  // Course order. Ideas that tie for a review keep the order they are read in, so it has to be the same on every read.
  const concepts = await prisma.concept.findMany({
    where: { projectId, status: 'active', topic: { userConfirmed: true } },
    orderBy: [{ topic: { orderIndex: 'asc' } }, { orderIndex: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, topicId: true, kind: true, topic: { select: { name: true } } },
  })
  const conceptMap = new Map<string, ConceptInfo>(concepts.map((c) => [c.id, { id: c.id, name: c.name, topicId: c.topicId, kind: c.kind }]))
  const topicNames = new Map(concepts.map((c) => [c.topicId, c.topic.name]))
  const topicIds = [...topicNames.keys()]

  const [rows, facts, edges, bank] = await Promise.all([
    prisma.conceptMemory.findMany({ where: { userId, projectId, conceptId: { in: [...conceptMap.keys()] } } }),
    loadSurrenderFacts(userId, projectId),
    prisma.conceptEdge.findMany({
      where: { projectId, type: 'confusable', status: { not: 'rejected' } },
      orderBy: { confidence: 'desc' },
      select: { sourceId: true, targetId: true, status: true, confidence: true },
    }),
    input.withBank === false ? Promise.resolve({ bank: [], stored: new Map<string, StoredItem>() }) : loadBank(userId, topicIds, new Set(conceptMap.keys())),
  ])

  // In course order, not the order the rows come back in, which changes as rows are rewritten.
  const rowOf = new Map(rows.map((row) => [row.conceptId, row]))
  const memories = new Map<string, MemorySummary>()
  for (const info of conceptMap.values()) {
    const row = rowOf.get(info.id)
    if (row) memories.set(info.id, summarise(row, info.kind, now))
  }

  const confusable = new Map<string, string>()
  for (const edge of edges) {
    if (edge.status !== 'confirmed' && edge.confidence < LINK_CONFIDENCE) continue
    if (!conceptMap.has(edge.sourceId) || !conceptMap.has(edge.targetId)) continue
    if (!confusable.has(edge.sourceId)) confusable.set(edge.sourceId, edge.targetId)
    if (!confusable.has(edge.targetId)) confusable.set(edge.targetId, edge.sourceId)
  }

  const due = dueConcepts({
    memories: [...memories.values()],
    surrendered: surrenderedDue(facts.filter((fact) => conceptMap.has(fact.conceptId)), now, timeZone),
    confusableOf: (id) => confusable.get(id),
    now,
    timeZone,
  })
  return { concepts: conceptMap, topicNames, memories, due, bank: bank.bank, stored: bank.stored, confusable }
}

/** A concept as a drill reads it: due or not, with whatever memory it has. */
export function asDrillConcept(context: ReviewContext, conceptId: string, now: Date): DueConcept | null {
  const info = context.concepts.get(conceptId)
  if (!info) return null
  const due = context.due.find((c) => c.conceptId === conceptId)
  if (due) return due
  const memory = context.memories.get(conceptId)
  const confusableId = context.confusable.get(conceptId)
  return {
    conceptId,
    topicId: info.topicId,
    misconception: memory?.misconception ?? false,
    dueAt: memory?.dueAt ?? now,
    retrievability: memory?.retrievability ?? 0,
    mastery: memory?.mastery ?? 0,
    lastMaxRung: toRung(memory?.lastMaxRung),
    bandInputs: memory?.bandInputs ?? UNKNOWN_BAND_INPUTS,
    modeReached: memory?.modeReached ?? 'recall',
    ...(toMissKind(memory?.lastMissKind) ? { lastMissKind: toMissKind(memory?.lastMissKind) } : {}),
    ...(confusableId ? { confusableId } : {}),
  }
}

/** The weakest prerequisite of a concept with memory, below the line (spec §7.4), as a drill concept. */
export async function weakestPrerequisite(
  context: ReviewContext,
  projectId: string,
  conceptId: string,
  now: Date
): Promise<DueConcept | null> {
  const edges = await prisma.conceptEdge.findMany({
    where: { projectId, type: 'prerequisite', targetId: conceptId, status: { not: 'rejected' } },
    select: { sourceId: true },
  })
  const candidates = edges.flatMap((edge) => {
    const memory = context.memories.get(edge.sourceId)
    const drill = memory ? asDrillConcept(context, edge.sourceId, now) : null
    return drill ? [drill] : []
  })
  return pickWeakestPrerequisite(candidates)
}

/** How many concepts a review session could draw on now (due by the concept's own schedule, or a surrendered step). */
export async function countDueConcepts(userId: string, projectId: string, timeZone: string, now: Date = new Date()): Promise<number> {
  return (await loadReviewContext({ userId, projectId, now, timeZone, withBank: false })).due.length
}
