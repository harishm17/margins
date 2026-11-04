/**
 * The instruction-after-failure loop (spec 18.5), the database half: writing an instruction event, and the one answer to
 * "what do I show after a miss" that every surface uses (spec 18.3). Server only.
 */

import { prisma } from '@/lib/db/prisma'
import { studentTimeZone } from './student-time-zone'
import type { InstructionKind } from './evidence-types'
import { newestAttempts, writtenGapConcepts } from './explainer-server'
import { recordEvidence } from './evidence'
import { instructionInput } from './instruction'
import type { Db } from './mastery'
import { loadTopicLearningState, recallGapConcepts } from './next-activity-server'
import { reviewSessionHref } from './review-links'

/** Where a surface shows the help: the practice step shows an easier problem; the others a worked example. */
export type HelpSurface = 'practice' | 'recall' | 'quiz' | 'review' | 'drill' | 'voice' | 'map' | 'warmup' | 'exam'

export type HelpAfterMiss = {
  /** One per concept: its first claim, as a link that opens the reader there (and records a `pointer` instruction event). */
  pointers: { conceptId: string; conceptName: string; page: number | null; chunkId: string | null; href: string }[]
  /** The gap explainer covering these concepts, when one exists or can be made. */
  explainer: { href: string; ready: boolean } | null
  /** Only for a concept in band 0, or one that has failed twice in a row. */
  easierStep: { kind: 'examples' | 'easier_problem' | 'prerequisite'; href: string; label: string } | null
}

const topicBase = (projectId: string, topicId: string) => `/courses/${projectId}/topics/${topicId}`

/**
 * What every surface shows after an "I don't know" or a failed first try (spec 18.3). Pointers come from stored claims, so
 * they work with the AI down. The pointer links need no model; opening one records the instruction (the topic page does it
 * server-side, `POST /api/topics/[topicId]/instruction` for a client view).
 *
 * `db` serves the reads of this function; the learning state behind the easier step is read from the shared client.
 */
export async function helpAfterMiss(
  db: Db | typeof prisma,
  input: { userId: string; topicId: string; conceptIds: string[]; surface: HelpSurface }
): Promise<HelpAfterMiss> {
  const empty: HelpAfterMiss = { pointers: [], explainer: null, easierStep: null }
  const topic = await db.topic.findFirst({ where: { id: input.topicId, project: { userId: input.userId } }, select: { id: true, projectId: true } })
  if (!topic) return empty
  const ids = [...new Set(input.conceptIds)]
  const concepts = await db.concept.findMany({
    where: { id: { in: ids }, projectId: topic.projectId, status: 'active' },
    select: { id: true, name: true, topicId: true },
  })
  const byId = new Map(concepts.map((c) => [c.id, c]))
  const known = ids.filter((id) => byId.has(id))
  if (known.length === 0) return empty

  const claims = await db.conceptClaim.findMany({
    where: { conceptId: { in: known } },
    orderBy: [{ conceptId: 'asc' }, { orderIndex: 'asc' }],
    select: { conceptId: true, chunkId: true, pageStart: true },
  })
  const first = new Map<string, { chunkId: string | null; page: number | null }>()
  for (const claim of claims) if (!first.has(claim.conceptId)) first.set(claim.conceptId, { chunkId: claim.chunkId, page: claim.pageStart })

  const pointers = known.map((conceptId) => {
    const concept = byId.get(conceptId)!
    const claim = first.get(conceptId) ?? { chunkId: null, page: null }
    return {
      conceptId,
      conceptName: concept.name,
      page: claim.page,
      chunkId: claim.chunkId,
      href: `${topicBase(topic.projectId, concept.topicId)}?view=read&focus=${encodeURIComponent(conceptId)}${claim.chunkId ? `#chunk-${claim.chunkId}` : ''}`,
    }
  })

  // The explainer: written for one of these concepts (ready), or a recall left a gap on one (it can be written).
  const attempts = await newestAttempts(input.userId, input.topicId)
  const wanted = new Set(known)
  const written = attempts.flatMap((attempt) => writtenGapConcepts(attempt.explainer)).find((id) => wanted.has(id))
  const gap = attempts.flatMap((attempt) => recallGapConcepts(attempt.result)).find((id) => wanted.has(id))
  const covered = written ?? gap
  const explainer = covered ? { href: `${topicBase(topic.projectId, input.topicId)}?view=explainer&focus=${encodeURIComponent(covered)}`, ready: written !== undefined } : null

  // The easier step: only for a concept in band 0 or one that failed twice in a row.
  const state = await loadTopicLearningState({ userId: input.userId, topicId: input.topicId, timeZone: await studentTimeZone() })
  const needy = state.concepts
    .filter((c) => wanted.has(c.id) && (c.band === 0 || c.consecutiveFails >= 2))
    .sort((a, b) => a.mastery - b.mastery)[0]
  let easierStep: HelpAfterMiss['easierStep'] = null
  if (needy) {
    const prerequisiteId = needy.prerequisiteWeak ? (needy.weakestPrerequisiteId ?? needy.prerequisiteIds[0]) : null
    if (prerequisiteId) {
      const prerequisite = await db.concept.findFirst({ where: { id: prerequisiteId, projectId: topic.projectId }, select: { name: true } })
      easierStep = {
        kind: 'prerequisite',
        href: reviewSessionHref(topic.projectId, { conceptId: prerequisiteId, topicId: input.topicId }),
        label: `Practice ${prerequisite?.name ?? 'what it builds on'} first`,
      }
    } else if (input.surface === 'practice') {
      easierStep = { kind: 'easier_problem', href: `${topicBase(topic.projectId, input.topicId)}?view=practice`, label: 'Try an easier problem' }
    } else {
      easierStep = {
        kind: 'examples',
        href: `${topicBase(topic.projectId, input.topicId)}?view=examples&focus=${encodeURIComponent(needy.id)}&fade=full`,
        label: 'See one worked through first',
      }
    }
  }
  return { pointers, explainer, easierStep }
}

export type RecordInstructionResult = { status: 'recorded' } | { status: 'present' } | { status: 'invalid' }

/**
 * Writes an instruction event on these concepts (spec 18.5), idempotent per (user, item key, local day): the same
 * instruction shown twice in a day is one event. The concepts must be active concepts of the student's own course; those
 * that are not are dropped, and with none left nothing is written. The item key is `instruction:<kind>:<ref>`.
 */
export async function recordInstruction(
  db: Db | typeof prisma,
  input: { userId: string; topicId: string; kind: InstructionKind; conceptIds: string[]; ref: string; timeZone?: string; at?: Date }
): Promise<RecordInstructionResult> {
  const topic = await db.topic.findFirst({ where: { id: input.topicId, project: { userId: input.userId } }, select: { id: true, projectId: true } })
  if (!topic) return { status: 'invalid' }
  const concepts = await db.concept.findMany({
    where: { id: { in: [...new Set(input.conceptIds)] }, projectId: topic.projectId, status: 'active' },
    select: { id: true },
  })
  if (concepts.length === 0) return { status: 'invalid' }
  const timeZone = input.timeZone ?? (await studentTimeZone())
  const event = instructionInput(input.kind, {
    userId: input.userId,
    projectId: topic.projectId,
    topicId: topic.id,
    conceptIds: concepts.map((c) => c.id),
    ref: input.ref,
    at: input.at ?? new Date(),
    timeZone,
  })
  const present = await db.evidenceEvent.count({ where: { userId: input.userId, itemKey: event.itemKey, sessionKey: event.sessionKey } })
  if (present > 0) return { status: 'present' }
  // The lock inside recordEvidence makes two of these at once write once.
  await recordEvidence([event], { timeZone, userId: input.userId, skipIfPresent: true })
  return { status: 'recorded' }
}
