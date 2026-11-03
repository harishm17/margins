/**
 * The server-side draft store (spec §18.7): one row per (user, surface, scopeKey) holding what a
 * student is in the middle of writing, so a closed tab, a reload or another device loses nothing.
 *
 * - Every function takes the signed-in user's id and filters on it; a draft is never reachable by
 *   another user. A write also needs the project (and the topic, when given) to be the user's.
 * - A write is a compare-and-set on `version`. Version 0 means "I believe there is no draft".
 *   A stale version returns `conflict` with the stored draft (or null when it is gone); the client
 *   decides which side is newer (use-server-draft.ts).
 * - A payload is at most 16 KB and must match the surface's shape (draft-contract.ts).
 * - A draft expires 14 days after its last write. An expired draft reads as absent and is removed;
 *   each write deletes the user's other expired drafts (no cron).
 * - A `quiz` draft may name a topic's legacy first quiz (set id `legacy`) while the topic has no quiz sets.
 * - Creating a `quiz` draft for a set with an attempt today (the student's zone) is refused with
 *   `retry_tomorrow`. Resuming an existing quiz draft never is.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { retryOpensAt } from '@/lib/learning/missed'
import { asQuestionList } from '@/lib/learning/quiz-questions'
import {
  DRAFT_TTL_MS,
  MAX_DRAFTS_PER_USER,
  parseDraftKey,
  quizSetOfKey,
  surfaceNamesTopic,
  topicOfKey,
  validateDraftPayload,
  type DraftSurface,
} from './draft-contract'

export { MAX_DRAFTS_PER_USER, MAX_DRAFT_BYTES, DRAFT_TTL_MS } from './draft-contract'

export type StoredDraft = { payload: unknown; version: number; updatedAt: Date; expiresAt: Date }

export type SaveDraftInput = {
  surface: DraftSurface
  key: string
  projectId: string
  topicId?: string | null
  payload: unknown
  /** The version the client last saw; 0 when it believes there is no draft. */
  version: number
}

export type SaveDraftResult =
  | { status: 'saved'; draft: StoredDraft }
  | { status: 'conflict'; draft: StoredDraft | null }
  | { status: 'retry_tomorrow'; opensAt: Date }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string }
  | { status: 'too_large'; message: string }
  | { status: 'too_many' }

type Options = { now?: Date; timeZone?: string }

const toStored = (row: { payload: Prisma.JsonValue; version: number; updatedAt: Date; expiresAt: Date }): StoredDraft => ({
  payload: row.payload,
  version: row.version,
  updatedAt: row.updatedAt,
  expiresAt: row.expiresAt,
})

const where = (userId: string, surface: DraftSurface, key: string) => ({ userId_surface_scopeKey: { userId, surface, scopeKey: key } })

/** The live row, or null. An expired row is deleted on the way, so it can be written again from scratch. */
async function findLive(userId: string, surface: DraftSurface, key: string, now: Date) {
  const row = await prisma.studyDraft.findUnique({ where: where(userId, surface, key) })
  if (!row) return null
  if (row.expiresAt.getTime() <= now.getTime()) {
    await prisma.studyDraft.deleteMany({ where: { id: row.id, expiresAt: { lte: now } } })
    return null
  }
  return row
}

/** When a quiz set was last taken (graded, or submitted and waiting for the AI), or null. */
async function lastTakenAt(userId: string, topicId: string, quizSetId: string): Promise<Date | null> {
  // Attempts and submissions on the legacy first quiz carry no set id.
  const setId = quizSetId === LEGACY_QUIZ_SET ? null : quizSetId
  const [attempt, submission] = await Promise.all([
    prisma.quizAttempt.findFirst({ where: { userId, topicId, quizSetId: setId }, orderBy: { takenAt: 'desc' }, select: { takenAt: true } }),
    prisma.quizSubmission.findFirst({ where: { userId, topicId, quizSetId: setId }, orderBy: { submittedAt: 'desc' }, select: { submittedAt: true } }),
  ])
  const times = [attempt?.takenAt, submission?.submittedAt].filter((t): t is Date => !!t)
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null
}

/** The set id the quiz view gives the first quiz of a topic that predates quiz sets (it has no TopicQuiz row). */
const LEGACY_QUIZ_SET = 'legacy'

/**
 * Whether the topic has this quiz. The legacy first quiz is the topic's own `topic_quiz` content, and only counts while
 * the topic has no quiz sets: the first set copies it into a row of its own, and the view then opens that row.
 */
async function quizSetExists(topicId: string, quizSetId: string): Promise<boolean> {
  if (quizSetId !== LEGACY_QUIZ_SET) return !!(await prisma.topicQuiz.findFirst({ where: { id: quizSetId, topicId }, select: { id: true } }))
  const [content, sets] = await Promise.all([
    prisma.topicContent.findUnique({ where: { topicId_contentType: { topicId, contentType: 'topic_quiz' } }, select: { contentData: true } }),
    prisma.topicQuiz.count({ where: { topicId } }),
  ])
  return sets === 0 && asQuestionList(content?.contentData) !== null
}

/**
 * The user's draft, or null. A key that is not this surface's shape reads as absent. A quiz draft
 * whose set no longer exists is deleted and reads as absent.
 */
export async function loadDraft(userId: string, surface: DraftSurface, key: string, options: Options = {}): Promise<StoredDraft | null> {
  if (!parseDraftKey(surface, key)) return null
  const now = options.now ?? new Date()
  const row = await findLive(userId, surface, key, now)
  if (!row) return null
  if (surface === 'quiz') {
    const topicId = topicOfKey('quiz', key)
    const setId = quizSetOfKey(key)
    if (!topicId || !setId || !(await quizSetExists(topicId, setId))) {
      await prisma.studyDraft.deleteMany({ where: { id: row.id } })
      return null
    }
  }
  return toStored(row)
}

/** Deletes the user's draft. Deleting what is not there is not an error. */
export async function clearDraft(userId: string, surface: DraftSurface, key: string): Promise<void> {
  await prisma.studyDraft.deleteMany({ where: { userId, surface, scopeKey: key } })
}

export async function saveDraft(userId: string, input: SaveDraftInput, options: Options = {}): Promise<SaveDraftResult> {
  const now = options.now ?? new Date()
  const { surface, key } = input
  const topicId = input.topicId ?? null

  // Shape first: a bad request is told so whoever owns the project.
  if (!parseDraftKey(surface, key)) return { status: 'invalid', message: 'Draft key does not match the surface.' }
  if (!Number.isInteger(input.version) || input.version < 0) return { status: 'invalid', message: 'Version must be a whole number from 0.' }
  const keyTopic = topicOfKey(surface, key)
  if (surfaceNamesTopic(surface) && keyTopic !== topicId) return { status: 'invalid', message: 'Draft key and topic disagree.' }
  const checked = validateDraftPayload(surface, input.payload)
  if (!checked.ok) return { status: checked.reason, message: checked.message }

  // Ownership: the project is the user's, and the topic is in it.
  const project = await prisma.project.findFirst({ where: { id: input.projectId, userId }, select: { id: true } })
  if (!project) return { status: 'not_found' }
  if (topicId && !(await prisma.topic.findFirst({ where: { id: topicId, projectId: project.id }, select: { id: true } }))) return { status: 'not_found' }

  // The user's other expired drafts go; this one is handled below so a client's version is judged against what is live.
  await prisma.studyDraft.deleteMany({ where: { userId, expiresAt: { lte: now }, NOT: { surface, scopeKey: key } } })

  const payload = checked.payload as Prisma.InputJsonValue
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS)
  const existing = await findLive(userId, surface, key, now)

  if (existing) {
    // Compare-and-set: only the writer who saw the stored version wins.
    const updated = await prisma.studyDraft.updateMany({
      where: { id: existing.id, version: input.version },
      data: { payload, version: { increment: 1 }, updatedAt: now, expiresAt, projectId: project.id, topicId },
    })
    if (updated.count === 1) return { status: 'saved', draft: toStored((await prisma.studyDraft.findUniqueOrThrow({ where: { id: existing.id } }))) }
    const stored = await findLive(userId, surface, key, now)
    return { status: 'conflict', draft: stored ? toStored(stored) : null }
  }

  // No live draft: only a client that believes so (version 0) may create one.
  if (input.version !== 0) return { status: 'conflict', draft: null }

  if (surface === 'quiz') {
    const setId = quizSetOfKey(key)
    if (!topicId || !setId || !(await quizSetExists(topicId, setId))) return { status: 'not_found' }
    const opensAt = retryOpensAt(await lastTakenAt(userId, topicId, setId), options.timeZone ?? 'UTC', now)
    if (opensAt) return { status: 'retry_tomorrow', opensAt }
  }
  if ((await prisma.studyDraft.count({ where: { userId, expiresAt: { gt: now } } })) >= MAX_DRAFTS_PER_USER) return { status: 'too_many' }

  try {
    const created = await prisma.studyDraft.create({
      data: { userId, projectId: project.id, topicId, surface, scopeKey: key, payload, version: 1, createdAt: now, updatedAt: now, expiresAt },
    })
    return { status: 'saved', draft: toStored(created) }
  } catch (error) {
    // Another tab created it between our read and our write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const stored = await findLive(userId, surface, key, now)
      return { status: 'conflict', draft: stored ? toStored(stored) : null }
    }
    throw error
  }
}
