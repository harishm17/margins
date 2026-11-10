import type { Prisma } from '@prisma/client'
import type { NextResponse } from 'next/server'
import { ApiErrorCode, apiError } from '@/lib/api/errors'
import { MAX_DRAFTS_PER_USER } from '@/lib/drafts/draft-contract'

/**
 * How much one account may create (SEC-M4). Every create that a student can repeat goes through `quota` inside its own
 * transaction: the count and the insert happen under one advisory lock for the scope (the account or the course), so two
 * requests at the edge cannot both pass. A student who is already over a cap keeps everything they have; only new
 * creates are refused, with the limit named in plain words.
 *
 * Caps come from the environment with the defaults below (QUOTA_COURSES, QUOTA_FILES_PER_COURSE, ...), read on each
 * call so a test or a deploy can change them.
 */
export type QuotaKind =
  | 'courses'
  | 'files'
  | 'storage'
  | 'units'
  | 'topics'
  | 'chatThreads'
  | 'voiceSessions'
  | 'notes'
  | 'drafts'
  | 'generationJobs'

/** What a kind counts within: a course, a topic, the bytes about to be added, or the moment a draft counts as live. */
export type QuotaScope = { projectId?: string; topicId?: string; bytes?: number; now?: Date }

/** Notes a student may keep on one topic. */
export const MAX_NOTES_PER_TOPIC = 500

/** The job types a student's request starts and the model runs for: these are what the daily cap counts. */
export const GENERATION_JOB_TYPES = ['generate_content', 'extract_topics', 'generate_exam'] as const

const DAY_MS = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

const SETTINGS: Record<QuotaKind, { env: string; fallback: number }> = {
  courses: { env: 'QUOTA_COURSES', fallback: 20 },
  files: { env: 'QUOTA_FILES_PER_COURSE', fallback: 30 },
  storage: { env: 'QUOTA_STORAGE_MB', fallback: 500 },
  units: { env: 'QUOTA_UNITS_PER_COURSE', fallback: 40 },
  topics: { env: 'QUOTA_TOPICS_PER_COURSE', fallback: 200 },
  chatThreads: { env: 'QUOTA_CHAT_THREADS_PER_COURSE', fallback: 200 },
  voiceSessions: { env: 'QUOTA_VOICE_SESSIONS_PER_DAY', fallback: 60 },
  notes: { env: 'QUOTA_NOTES_PER_TOPIC', fallback: MAX_NOTES_PER_TOPIC },
  drafts: { env: 'QUOTA_DRAFTS', fallback: MAX_DRAFTS_PER_USER },
  generationJobs: { env: 'QUOTA_GENERATION_JOBS_PER_DAY', fallback: 200 },
}

/** The cap for a kind: the environment value when it is a positive whole number, else the default. */
export function quotaLimit(kind: QuotaKind, env: Record<string, string | undefined> = process.env): number {
  const { env: name, fallback } = SETTINGS[kind]
  const value = Number(env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const MESSAGES: Record<QuotaKind, (limit: number) => string> = {
  courses: (n) => `You can have up to ${n} courses. Delete one to add another.`,
  files: (n) => `A course can hold up to ${n} files.`,
  storage: (n) => `Your files can take up to ${n} MB in all. Delete a file to add another.`,
  units: (n) => `A course can have up to ${n} units.`,
  topics: (n) => `A course can have up to ${n} topics.`,
  chatThreads: (n) => `A course can have up to ${n} chats. Delete one to start another.`,
  voiceSessions: (n) => `You can start up to ${n} voice sessions a day. Try again tomorrow.`,
  notes: () => 'This topic has as many notes as it can hold. Delete one to add another.',
  drafts: () => 'Too many unfinished drafts. Finish or discard some.',
  generationJobs: (n) => `You have reached today's limit of ${n} study-material requests. Try again tomorrow.`,
}

export type QuotaRefusal = { kind: QuotaKind; limit: number; message: string }

type Db = Prisma.TransactionClient

/** What the lock is taken on, so creates in one course (or one account) queue behind each other and nothing else. */
function lockScope(kind: QuotaKind, userId: string, scope: QuotaScope): string {
  switch (kind) {
    case 'files':
    case 'units':
    case 'topics':
    case 'chatThreads':
      return `${kind}:${scope.projectId ?? userId}`
    case 'notes':
      return `${kind}:${userId}:${scope.topicId ?? ''}`
    default:
      return `${kind}:${userId}`
  }
}

async function used(tx: Db, kind: QuotaKind, userId: string, scope: QuotaScope): Promise<number> {
  const since = new Date(Date.now() - DAY_MS)
  switch (kind) {
    case 'courses':
      return tx.project.count({ where: { userId } })
    case 'files':
      return tx.material.count({ where: { projectId: scope.projectId } })
    case 'storage': {
      const total = await tx.material.aggregate({ where: { project: { userId } }, _sum: { sizeBytes: true } })
      return Number(total._sum.sizeBytes ?? 0)
    }
    case 'units':
      return tx.unit.count({ where: { projectId: scope.projectId } })
    case 'topics':
      return tx.topic.count({ where: { projectId: scope.projectId } })
    case 'chatThreads':
      return tx.chatThread.count({ where: { userId, projectId: scope.projectId } })
    case 'voiceSessions':
      return tx.voiceDrillSession.count({ where: { userId, createdAt: { gte: since } } })
    case 'notes':
      return tx.marginNote.count({ where: { userId, topicId: scope.topicId } })
    case 'drafts':
      return tx.studyDraft.count({ where: { userId, expiresAt: { gt: scope.now ?? new Date() } } })
    case 'generationJobs':
      return tx.processingJob.count({ where: { userId, jobType: { in: [...GENERATION_JOB_TYPES] }, createdAt: { gte: since } } })
  }
}

/**
 * Whether the account may create one more of `kind`. Call it inside the create's transaction, after taking nothing
 * else: it takes the advisory lock for the scope itself, counts, and returns a refusal (to send as `quotaResponse`) or
 * null. The lock is released when the transaction ends, so the caller must insert before it commits.
 *
 * `scope.bytes` is the size of the file about to be added (kind `storage`): the cap is on the total after the add.
 */
export async function quota(tx: Db, user: { id: string }, kind: QuotaKind, scope: QuotaScope = {}): Promise<QuotaRefusal | null> {
  const limit = quotaLimit(kind)
  const cap = kind === 'storage' ? limit * MB : limit
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${lockScope(kind, user.id, scope)}`}))`
  const count = await used(tx, kind, user.id, scope)
  const next = kind === 'storage' ? count + (scope.bytes ?? 0) : count + 1
  if (next <= cap) return null
  return { kind, limit, message: MESSAGES[kind](limit) }
}

/** The 409 for a refused create. The message is shown to the student as it is. */
export function quotaResponse(refusal: QuotaRefusal): NextResponse {
  return apiError(ApiErrorCode.CONFLICT, refusal.message, { code: 'QUOTA_EXCEEDED', kind: refusal.kind, limit: refusal.limit, retryable: false }, 409)
}

/** Thrown by `assertQuota` inside a create's transaction; the route's catch turns it into the 409 with `quotaErrorResponse`. */
export class QuotaExceededError extends Error {
  constructor(readonly refusal: QuotaRefusal) {
    super(`Quota exceeded: ${refusal.kind}`)
    this.name = 'QuotaExceededError'
  }
}

/** `quota`, but throws `QuotaExceededError` on a refusal, which rolls the transaction back. */
export async function assertQuota(tx: Db, user: { id: string }, kind: QuotaKind, scope: QuotaScope = {}): Promise<void> {
  const refusal = await quota(tx, user, kind, scope)
  if (refusal) throw new QuotaExceededError(refusal)
}

/** In a route's catch: the 409 when `error` is a refused create, else null. */
export function quotaErrorResponse(error: unknown): NextResponse | null {
  return error instanceof QuotaExceededError ? quotaResponse(error.refusal) : null
}
