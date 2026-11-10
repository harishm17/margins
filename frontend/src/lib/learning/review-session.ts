/**
 * Review sessions and concept drills (spec §7.4, D7). Both are `ItemSession` rows, never quiz attempts.
 *
 * - `items` holds the items as served, with their answer keys, so regenerating a bank later cannot change
 *   what was graded. The browser only ever gets the public form.
 * - `answers` holds the student's answers by item index.
 * - `results` holds the session's state (`SessionMeta`): its scope, the jobs it waits for, the graded
 *   result of each answered item, and whether the closing retests are built.
 *
 * A session is built from `selectReviewItems` (or `selectDrillItems`). Concepts that lack a fresh item
 * get one `generate_review_items` job per topic, and the session fills in when the jobs finish: the
 * browser polls the session, and every read advances it. When every item of a review is answered it
 * serves `closingRetests` (a fresh item for each miss) before it completes. The pace is the student's:
 * nothing here moves on by itself.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { gradeAnswers } from '@/lib/ai-service/grading'
import { blockedCode } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { createJobOrFindActive, reviewItemsTarget } from '@/lib/jobs/active-jobs'
import { enqueueReviewItemsJob, TaskEnqueueError } from '@/lib/tasks/dispatch'
import { asDrillConcept, loadReviewContext, weakestPrerequisite, type ReviewContext } from './review-bank'
import { selectDrillItems } from './drill-select'
import { recordEvidence } from './evidence'
import { dueBoundary } from './next-step'
import { requestsByTopic, type ReviewItemRequest } from './review-requests'
import {
  appendInterleaved,
  byPriority,
  closingRetests,
  selectReviewItems,
  sessionShape,
  type AnsweredItem,
  type BankItem,
  type Difficulty,
  type DueConcept,
  type MissingItems,
  type Mode,
} from './review-select'
import { normalizeAnswers, answersForGrader, dontKnowIndexes, isAnswered, type QuizAnswer } from './quiz-answers'
import { buildGradedEvidence } from './quiz-evidence'
import { dontKnowEvidence } from './dont-know'
import { helpAfterMiss, type HelpAfterMiss } from './instruction-server'
import { localDateParts } from './study-plan-time'
import { toPublicQuestion } from './quiz-questions'
import { buildReview, toStoredResults } from './quiz-review'
import {
  firstUnanswered,
  type PublicAnswered,
  type PublicSessionItem,
  type SessionKind,
  type SessionPhase,
  type SessionStatus,
  type SessionSummary,
  type SessionView,
} from './review-session-types'

type RawQuestion = Record<string, unknown>

/** A review session holds up to this many items (spec §7.4), not counting its closing retests. */
export const MAX_REVIEW_ITEMS = 12
/** Due concepts of other topics that join a session filtered to one topic. */
const OTHER_TOPIC_CONCEPTS = 2
/** An answer at or above this is a success (the same line the mode and mastery replay use). */
const SUCCESS = 0.75
/** A job that has not finished in this long is no longer waited for. */
const JOB_WAIT_MS = 4 * 60 * 1000

type SessionItem = {
  itemKey: string
  topicId: string
  conceptIds: string[]
  mode: Mode
  difficulty: Difficulty
  phase: SessionPhase
  question: RawQuestion
}

type GradedItem = {
  answer: string
  idk?: boolean
  confidence?: number
  thinking?: string
  score: number
  correct: boolean
  review: PublicAnswered['review']
}

type Pending = { jobId: string; topicId: string; for: 'main' | 'retest'; startedAt: string }

type SessionMeta = {
  scope: {
    topicId?: string
    conceptId?: string
    topicIds?: string[]
    /** Practice on what a mock exam's missed questions were about (needs `includeNotDue` for the topic form): the concepts to draw on. */
    conceptIds?: string[]
    /** Where the session came from, for its title. */
    from?: 'exam'
  }
  /** How many items a review holds (default 12), and whether the topic's concepts that are not due may join (spec 7.4, 18.8). */
  limit?: number
  includeNotDue?: boolean
  /** How many closing retests at most (none given: one for each miss). */
  retestCap?: number
  /** The 10-minute session (spec 18.8). */
  short?: boolean
  /** A session left unfinished on an earlier day, closed when a new one started. */
  abandoned?: boolean
  pending: Pending[]
  /** The retest jobs have been asked for once; a session never asks twice. */
  requested: { retest: boolean }
  retestsBuilt: boolean
  graded: Record<string, GradedItem>
  failure: string | null
}

const emptyMeta = (scope: SessionMeta['scope']): SessionMeta => ({
  scope,
  pending: [],
  requested: { retest: false },
  retestsBuilt: false,
  graded: {},
  failure: null,
})

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function readMeta(value: unknown): SessionMeta {
  const base = emptyMeta({})
  if (!isRecord(value)) return base
  return {
    scope: isRecord(value.scope) ? (value.scope as SessionMeta['scope']) : {},
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
    ...(value.includeNotDue === true ? { includeNotDue: true } : {}),
    ...(typeof value.retestCap === 'number' ? { retestCap: value.retestCap } : {}),
    ...(value.short === true ? { short: true } : {}),
    ...(value.abandoned === true ? { abandoned: true } : {}),
    pending: Array.isArray(value.pending) ? (value.pending as Pending[]) : [],
    requested: isRecord(value.requested) ? { ...base.requested, ...(value.requested as SessionMeta['requested']) } : base.requested,
    retestsBuilt: value.retestsBuilt === true,
    graded: isRecord(value.graded) ? (value.graded as Record<string, GradedItem>) : {},
    failure: typeof value.failure === 'string' ? value.failure : null,
  }
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const asBankItem = (item: SessionItem): BankItem => ({
  itemKey: item.itemKey,
  conceptIds: item.conceptIds,
  difficulty: item.difficulty,
  mode: item.mode,
  topicId: item.topicId,
  lastAnsweredAt: null,
})

function toSessionItem(bank: BankItem, context: ReviewContext, phase: SessionPhase): SessionItem | null {
  const stored = context.stored.get(bank.itemKey)
  if (!stored) return null
  return {
    itemKey: bank.itemKey,
    topicId: bank.topicId,
    conceptIds: bank.conceptIds,
    mode: bank.mode,
    difficulty: bank.difficulty,
    phase,
    question: stored.question,
  }
}

function readItems(value: unknown): SessionItem[] {
  return Array.isArray(value) ? (value.filter(isRecord) as unknown as SessionItem[]) : []
}

// ------------------------------------------------------------------------------------------ selection

/** The due concepts of a session filtered to a topic: that topic's, and up to two of the most pressing others. */
function scopedDue(due: DueConcept[], topicId: string | undefined, timeZone: string): DueConcept[] {
  if (!topicId) return due
  const others = due.filter((c) => c.topicId !== topicId).sort(byPriority(timeZone)).slice(0, OTHER_TOPIC_CONCEPTS)
  return [...due.filter((c) => c.topicId === topicId), ...others]
}

/**
 * The concepts a review draws on. Normally the due ones (see `scopedDue`). A short session with `includeNotDue` draws on every
 * concept of its topic(s), due or not, weakest first (spec 18.8): the mini quiz of a topic nothing is due in.
 */
function sessionConcepts(context: ReviewContext, meta: SessionMeta, now: Date, timeZone: string): DueConcept[] {
  // Weakest first; ideas that tie (unstudied ones all do) in course order, the same on every run.
  const place = new Map([...context.concepts.keys()].map((id, index) => [id, index]))
  const weakestFirst = (a: DueConcept, b: DueConcept) => a.mastery - b.mastery || (place.get(a.conceptId) ?? 0) - (place.get(b.conceptId) ?? 0)
  // Practice on what an exam's misses were about: exactly those concepts, due or not, weakest first.
  if (meta.scope.conceptIds) {
    return meta.scope.conceptIds.flatMap((id) => asDrillConcept(context, id, now) ?? []).sort(weakestFirst)
  }
  const topics = meta.scope.topicIds ?? (meta.scope.topicId ? [meta.scope.topicId] : undefined)
  if (!meta.includeNotDue || !topics) return scopedDue(context.due, meta.scope.topicId, timeZone)
  const wanted = new Set(topics)
  return [...context.concepts.values()]
    .filter((info) => wanted.has(info.topicId))
    .flatMap((info) => asDrillConcept(context, info.id, now) ?? [])
    .sort(weakestFirst)
}

type Plan = { add: SessionItem[]; missing: MissingItems[] }

/** What the review adds to a session that serves `served` already: the whole shape at the start, items for the rest later. */
function planReview(context: ReviewContext, meta: SessionMeta, served: SessionItem[], now: Date, timeZone: string): Plan {
  const servedConcepts = new Set(served.flatMap((item) => item.conceptIds))
  const servedKeys = new Set(served.map((item) => item.itemKey))
  const due = sessionConcepts(context, meta, now, timeZone).filter((c) => !servedConcepts.has(c.conceptId))
  const bank = context.bank.filter((item) => !servedKeys.has(item.itemKey))
  const room = (meta.limit ?? MAX_REVIEW_ITEMS) - served.filter((item) => item.phase === 'opening' || item.phase === 'body').length
  if (room <= 0) return { add: [], missing: [] }
  const selected = selectReviewItems({ due, bank, now, max: room, timeZone })

  const mastery = Object.fromEntries(sessionConcepts(context, meta, now, timeZone).map((c) => [c.conceptId, c.mastery]))
  let placed: { item: BankItem; phase: SessionPhase }[]
  if (served.length === 0) {
    const shape = sessionShape(selected.items, mastery)
    placed = [...shape.opening.map((item) => ({ item, phase: 'opening' as const })), ...shape.body.map((item) => ({ item, phase: 'body' as const }))]
  } else {
    const { placed: more } = appendInterleaved(served.map(asBankItem), selected.items, served.length + room)
    placed = more.map((item) => ({ item, phase: 'body' as const }))
  }
  const add = placed.flatMap(({ item, phase }) => toSessionItem(item, context, phase) ?? [])
  return { add, missing: selected.missing }
}

/** A drill's items: the weak prerequisite's, then 3 to 5 on the concept. */
async function planDrill(
  context: ReviewContext,
  meta: SessionMeta,
  served: SessionItem[],
  userProject: { projectId: string },
  now: Date,
  timeZone: string
): Promise<Plan> {
  const conceptId = meta.scope.conceptId as string
  const concept = asDrillConcept(context, conceptId, now)
  if (!concept) return { add: [], missing: [] }
  const prerequisite = await weakestPrerequisite(context, userProject.projectId, conceptId, now)
  const selected = selectDrillItems({ concept, prerequisite, bank: context.bank, served: served.map(asBankItem), now, timeZone })
  const add = selected.items.flatMap((item) => {
    const phase: SessionPhase = prerequisite && item.conceptIds.includes(prerequisite.conceptId) ? 'prerequisite' : 'drill'
    return toSessionItem(item, context, phase) ?? []
  })
  return { add, missing: selected.missing }
}

// ------------------------------------------------------------------------------------------ jobs

type JobToSend = { jobId: string; topicId: string; requests: ReviewItemRequest[] }

/** Creates (or follows) one review-item job per topic. Returns the jobs to wait for and those to send. */
async function startJobs(
  userId: string,
  projectId: string,
  missing: MissingItems[],
  purpose: 'main' | 'retest'
): Promise<{ pending: Pending[]; toSend: JobToSend[] }> {
  const pending: Pending[] = []
  const toSend: JobToSend[] = []
  // With the AI unavailable the session goes on with the items it has.
  if (missing.length === 0 || blockedCode(await getAiStatus(userId))) return { pending, toSend }
  for (const [topicId, requests] of requestsByTopic(missing)) {
    const { job, created } = await createJobOrFindActive({
      userId,
      projectId,
      jobType: 'generate_review_items',
      status: 'pending',
      stage: 'generating',
      inputData: { topicId, requests },
      progressPercent: 0,
      targetKey: reviewItemsTarget(topicId),
    })
    pending.push({ jobId: job.id, topicId, for: purpose, startedAt: new Date().toISOString() })
    if (created) toSend.push({ jobId: job.id, topicId, requests })
  }
  return { pending, toSend }
}

/** Hands the new jobs to the AI service, after the session row is saved. A job that cannot be sent is marked failed. */
async function sendJobs(jobs: JobToSend[]): Promise<void> {
  for (const job of jobs) {
    try {
      await enqueueReviewItemsJob(job.jobId, job.topicId, job.requests)
    } catch (error) {
      const retryable = error instanceof TaskEnqueueError ? error.retryable : true
      await prisma.processingJob.update({
        where: { id: job.jobId },
        data: {
          status: 'failed',
          errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
          errorMessage: 'Failed to enqueue review item generation',
          retryable,
          completedAt: new Date(),
        },
      })
    }
  }
}

/** Whether every job the session waits for has finished (or been given up on). */
async function jobsSettled(pending: Pending[], now: Date): Promise<boolean> {
  if (pending.length === 0) return true
  const rows = await prisma.processingJob.findMany({ where: { id: { in: pending.map((p) => p.jobId) } }, select: { id: true, status: true } })
  const status = new Map(rows.map((row) => [row.id, row.status]))
  return pending.every((p) => {
    const state = status.get(p.jobId)
    if (!state || state === 'completed' || state === 'failed') return true
    return now.getTime() - Date.parse(p.startedAt) > JOB_WAIT_MS
  })
}

// ------------------------------------------------------------------------------------------ the session row

export type StartResult =
  | { status: 'created'; sessionId: string }
  /** Nothing to serve. `legacyReview`: the filtered topic has a quiz-based review due (it has no concepts to serve). */
  | { status: 'empty'; legacyReview: boolean }
  | { status: 'blocked'; code: string }
  | { status: 'not_found' }

const localDayKey = (at: Date, timeZone: string): number => {
  const { year, month, day } = localDateParts(at, timeZone)
  return year * 10000 + month * 100 + day
}

/**
 * Closes the course's review and drill sessions that were left unfinished on an earlier local day, as abandoned (spec 18.7).
 * What was answered keeps its evidence; the session is simply over. Today's unfinished sessions are left alone: the Review page
 * offers to resume the newest (`activeSession`).
 */
async function closeStaleSessions(input: { userId: string; projectId: string; now: Date; timeZone: string }): Promise<void> {
  const open = await prisma.itemSession.findMany({
    where: { userId: input.userId, projectId: input.projectId, kind: { in: ['review', 'drill'] }, completedAt: null },
    select: { id: true, createdAt: true, results: true },
  })
  const today = localDayKey(input.now, input.timeZone)
  for (const row of open) {
    if (localDayKey(row.createdAt, input.timeZone) >= today) continue
    const meta = readMeta(row.results)
    meta.abandoned = true
    await prisma.itemSession.updateMany({ where: { id: row.id, completedAt: null }, data: { completedAt: input.now, results: asJson(meta) } })
  }
}

/** `topicId` is the topic the session is filtered to, when it is; the Review page resumes only a session that does the same work as the one it would start. */
export type ActiveSession = { sessionId: string; answered: number; total: number; kind: SessionKind; short: boolean; topicId: string | null }

/**
 * Today's newest unfinished review session of the course, for "Resume today's review (5 of 12)" (spec 18.7). A session from an
 * earlier day is not offered; it is closed when a new one starts. Null when there is none.
 */
export async function activeSession(userId: string, projectId: string, timeZone: string, now: Date = new Date()): Promise<ActiveSession | null> {
  const today = localDayKey(now, timeZone)
  const open = await prisma.itemSession.findMany({
    where: { userId, projectId, kind: 'review', completedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, createdAt: true, items: true, results: true },
  })
  // A practice session started from an exam's results is not "today's review": it is found again by its own address.
  const row = open.find((candidate) => localDayKey(candidate.createdAt, timeZone) === today && readMeta(candidate.results).scope.from !== 'exam')
  if (!row) return null
  const meta = readMeta(row.results)
  const items = readItems(row.items)
  // A session whose questions are still being written has nothing to resume yet.
  if (items.length === 0) return null
  return { sessionId: row.id, answered: Object.keys(meta.graded).length, total: items.length, kind: 'review', short: meta.short === true, topicId: meta.scope.topicId ?? null }
}

const lockSession = (tx: Prisma.TransactionClient, sessionId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`item_session:${sessionId}`}))`

/** The topic has a review due on its quiz-based schedule (a course from before concepts, or a topic whose extraction failed). */
async function legacyReviewDue(userId: string, topicId: string, timeZone: string, now: Date): Promise<boolean> {
  const schedule = await prisma.reviewSchedule.findUnique({ where: { userId_topicId: { userId, topicId } }, select: { dueAt: true } })
  return !!schedule && schedule.dueAt.getTime() < dueBoundary(now, timeZone).getTime()
}

/**
 * How many questions a review session started now with these settings would have: `ready` are in the bank and go in at once, `toWrite`
 * are concepts that need a question written first (the session waits for the job, and a failed job leaves it shorter). Nothing is
 * stored and no job is started. The 10-minute card says this number, so it never promises more than the session serves.
 */
export async function previewReviewSize(input: {
  userId: string
  projectId: string
  timeZone: string
  now?: Date
  limit?: number
  includeNotDue?: boolean
  topicIds?: string[]
}): Promise<{ ready: number; toWrite: number }> {
  const { userId, projectId, timeZone } = input
  const now = input.now ?? new Date()
  const meta = emptyMeta(input.topicIds?.length ? { topicId: input.topicIds[0], topicIds: input.topicIds } : {})
  if (input.limit !== undefined) meta.limit = Math.max(1, Math.min(MAX_REVIEW_ITEMS, Math.floor(input.limit)))
  if (input.includeNotDue) meta.includeNotDue = true
  const context = restrictToRuleGraded(await loadReviewContext({ userId, projectId, now, timeZone }), blockedCode(await getAiStatus(userId)))
  const plan = planReview(context, meta, [], now, timeZone)
  const served = new Set(plan.add.flatMap((item) => item.conceptIds))
  const written = new Set(plan.missing.flatMap((group) => group.conceptIds).filter((id) => !served.has(id)))
  const room = meta.limit ?? MAX_REVIEW_ITEMS
  return { ready: plan.add.length, toWrite: Math.max(0, Math.min(written.size, room - plan.add.length)) }
}

/**
 * Builds a review session (all due concepts, or one topic's plus two others) or a drill on one concept.
 * Nothing is stored when there is nothing to serve; a session whose items must all be written first
 * is refused with the AI's reason when the AI is unavailable.
 */
export async function startSession(input: {
  userId: string
  projectId: string
  kind: SessionKind
  topicId?: string
  conceptId?: string
  timeZone: string
  now?: Date
  /** How many items a review holds, at most (default 12). */
  limit?: number
  /** Draw on the topic's concepts whether or not they are due (needs `topicIds`): the mini quiz of the short session. */
  includeNotDue?: boolean
  /** How many closing retests at most; 0 for none. Without it, one for each miss. */
  retestCap?: number
  /** The topics a review is filtered to (the short session's current topic). */
  topicIds?: string[]
  /** The 10-minute session (spec 18.8). */
  short?: boolean
  /** Practice from a mock exam's results: the concepts (or the topics, with `topicIds`) its missed questions were about. */
  fromExam?: { conceptIds?: string[] }
}): Promise<StartResult> {
  const { userId, projectId, kind, timeZone } = input
  const now = input.now ?? new Date()
  const scope: SessionMeta['scope'] = input.fromExam
    ? { ...(input.fromExam.conceptIds ? { conceptIds: input.fromExam.conceptIds } : input.topicIds?.length ? { topicIds: input.topicIds } : {}), from: 'exam' }
    : kind === 'drill'
      ? { conceptId: input.conceptId }
      : input.topicIds?.length
        ? { topicId: input.topicIds[0], topicIds: input.topicIds }
        : input.topicId
          ? { topicId: input.topicId }
          : {}
  // A session left unfinished on an earlier day is over (spec 18.7).
  await closeStaleSessions({ userId, projectId, now, timeZone })
  const context = await loadReviewContext({ userId, projectId, now, timeZone })
  const meta = emptyMeta(scope)
  if (input.limit !== undefined) meta.limit = Math.max(1, Math.min(MAX_REVIEW_ITEMS, Math.floor(input.limit)))
  if (input.includeNotDue) meta.includeNotDue = true
  if (input.retestCap !== undefined) meta.retestCap = Math.max(0, Math.floor(input.retestCap))
  if (input.short) meta.short = true
  if (kind === 'drill' && (!input.conceptId || !context.concepts.has(input.conceptId))) return { status: 'not_found' }
  // A topic with no concepts is still a topic of the course: its answer is "nothing to serve", with its legacy review noted.
  if (kind === 'review' && input.topicId && !(await prisma.topic.findFirst({ where: { id: input.topicId, projectId }, select: { id: true } }))) return { status: 'not_found' }
  if (kind === 'review' && input.topicIds?.length && (await prisma.topic.count({ where: { id: { in: input.topicIds }, projectId } })) !== new Set(input.topicIds).size) return { status: 'not_found' }

  // With the AI unavailable only items graded by rule are served: a short answer could not be graded.
  const blocked = blockedCode(await getAiStatus(userId))
  const usable = restrictToRuleGraded(context, blocked)
  const plan = kind === 'drill' ? await planDrill(usable, meta, [], { projectId }, now, timeZone) : planReview(usable, meta, [], now, timeZone)
  if (plan.add.length === 0 && plan.missing.length === 0 && blocked) {
    // Every item that is due needs the model to grade it: that is the AI's doing, not "nothing is due".
    const all = kind === 'drill' ? await planDrill(context, meta, [], { projectId }, now, timeZone) : planReview(context, meta, [], now, timeZone)
    if (all.add.length > 0) return { status: 'blocked', code: blocked }
  }
  if (plan.add.length === 0 && plan.missing.length === 0) {
    return { status: 'empty', legacyReview: kind === 'review' && !!input.topicId && (await legacyReviewDue(userId, input.topicId, timeZone, now)) }
  }
  if (plan.add.length === 0 && blocked) return { status: 'blocked', code: blocked }

  const jobs = await startJobs(userId, projectId, plan.missing, 'main')
  meta.pending = jobs.pending

  const topicIds = [...new Set([...plan.add.map((item) => item.topicId), ...plan.missing.map((m) => m.topicId)])]
  const session = await prisma.itemSession.create({
    data: { userId, projectId, kind, topicIds, items: asJson(plan.add), answers: {}, results: asJson(meta) },
    select: { id: true },
  })
  await sendJobs(jobs.toSend)
  return { status: 'created', sessionId: session.id }
}

/** The retests for the misses so far: items to add, and what the job is to write for the concepts with none. */
function planRetests(context: ReviewContext, items: SessionItem[], meta: SessionMeta, now: Date, timeZone: string): Plan {
  const servedRetests = items.filter((item) => item.phase === 'retest')
  const retested = new Set(servedRetests.flatMap((item) => item.conceptIds))
  const answered: AnsweredItem[] = []
  items.forEach((item, index) => {
    const graded = meta.graded[String(index)]
    if (!graded || item.phase === 'retest' || item.phase === 'drill' || item.phase === 'prerequisite') return
    const correct = graded.score >= SUCCESS
    // A concept that already has its retest in the session is not retested again.
    if (!correct && item.conceptIds.every((id) => retested.has(id))) return
    answered.push({
      itemKey: item.itemKey,
      conceptIds: item.conceptIds,
      correct,
      maxRung: 0,
      surrendered: false,
      topicId: item.topicId,
      mode: item.mode,
      difficulty: item.difficulty,
    })
  })
  // Retests already served count as answered, so the same item is never picked twice.
  for (const item of servedRetests) {
    answered.push({ itemKey: item.itemKey, conceptIds: item.conceptIds, correct: true, maxRung: 0, surrendered: false, topicId: item.topicId })
  }
  const { items: retests, missing } = closingRetests(answered, context.bank, { now, timeZone })
  const add = retests.flatMap((bank) => toSessionItem(bank, context, 'retest') ?? [])
  // A short session caps its retests (the 10-minute review has two, the mini quiz none).
  if (meta.retestCap === undefined) return { add, missing }
  const room = Math.max(0, meta.retestCap - servedRetests.length)
  return { add: add.slice(0, room), missing: room > add.length ? missing.slice(0, room - add.length) : [] }
}

/** An answer the model must grade (a short answer) cannot be graded while the AI is unavailable. */
const needsModel = (question: RawQuestion | undefined) => !question || question.question_type === 'short_answer'

/** The context with only the items that can be graded by rule, for a session that starts or goes on while the AI is blocked. */
function restrictToRuleGraded(context: ReviewContext, blocked: string | null): ReviewContext {
  if (!blocked) return context
  return { ...context, bank: context.bank.filter((item) => !needsModel(context.stored.get(item.itemKey)?.question)) }
}

type Advanced = { items: SessionItem[]; meta: SessionMeta; finished: boolean; changed: boolean; toSend: JobToSend[] }

/**
 * Works out what a session needs next from the row as read: finished jobs settled and what they wrote
 * added, the closing retests built once every item is answered, the session completed. All the reads and
 * the jobs it starts happen here, before any lock is taken.
 */
async function computeAdvance(
  row: { kind: string; projectId: string; userId: string; items: Prisma.JsonValue; results: Prisma.JsonValue },
  timeZone: string,
  now: Date
): Promise<Advanced | null> {
  const meta = readMeta(row.results)
  let items = readItems(row.items)
  let changed = false
  const toSend: JobToSend[] = []
  const answeredAll = () => items.length > 0 && items.every((_item, i) => meta.graded[String(i)])
  let context: ReviewContext | null = null
  const load = async () =>
    (context ??= restrictToRuleGraded(
      await loadReviewContext({ userId: row.userId, projectId: row.projectId, now, timeZone }),
      blockedCode(await getAiStatus(row.userId))
    ))

  // 1. The jobs the session waits for.
  if (meta.pending.length > 0) {
    if (!(await jobsSettled(meta.pending, now))) return null
    const purpose = meta.pending[0].for
    meta.pending = []
    changed = true
    const ctx = await load()
    if (purpose === 'main') {
      const plan =
        row.kind === 'drill'
          ? await planDrill(ctx, meta, items, { projectId: row.projectId }, now, timeZone)
          : planReview(ctx, meta, items, now, timeZone)
      items = [...items, ...plan.add]
      if (items.length === 0) meta.failure = 'We could not prepare questions for this right now. Try again in a minute.'
    } else {
      items = [...items, ...planRetests(ctx, items, meta, now, timeZone).add]
    }
  }

  // 2. Every item answered: a review serves one fresh item for each miss before it ends.
  if (row.kind === 'review' && !meta.retestsBuilt && meta.pending.length === 0 && answeredAll()) {
    const ctx = await load()
    const plan = planRetests(ctx, items, meta, now, timeZone)
    meta.retestsBuilt = true
    changed = true
    items = [...items, ...plan.add]
    if (plan.missing.length > 0 && !meta.requested.retest) {
      meta.requested.retest = true
      const jobs = await startJobs(row.userId, row.projectId, plan.missing, 'retest')
      meta.pending = jobs.pending
      toSend.push(...jobs.toSend)
    }
  }

  // Nothing to serve and nothing to wait for: the session cannot start.
  if (items.length === 0 && meta.pending.length === 0 && !meta.failure) {
    meta.failure = 'We could not prepare questions for this right now. Try again in a minute.'
    changed = true
  }

  // 3. Done: everything answered, nothing awaited, and (for a review) the retests built.
  const finished = meta.pending.length === 0 && answeredAll() && (row.kind === 'drill' || meta.retestsBuilt)
  return { items, meta, finished, changed, toSend }
}

/** Moves a session forward. The work is done from a read of the row; the write holds the lock only to check the row is unchanged. */
async function advance(userId: string, sessionId: string, timeZone: string, now: Date = new Date()): Promise<void> {
  // A job a failed attempt created is still owed to the AI service: an attempt that runs again finds it
  // already there (created: false) and would not send it, so the jobs are kept across attempts.
  const toSend: JobToSend[] = []
  try {
    // Another reader or an answer can change the row between the read and the write; then the work is done again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await prisma.itemSession.findFirst({ where: { id: sessionId, userId } })
      if (!row || row.completedAt) return
      const next = await computeAdvance(row, timeZone, now)
      if (!next) return
      toSend.push(...next.toSend)
      if (!next.finished && !next.changed) return
      const written = await prisma.$transaction(
        async (tx) => {
          await lockSession(tx, sessionId)
          const current = await tx.itemSession.findFirst({ where: { id: sessionId, userId }, select: { items: true, results: true, completedAt: true } })
          if (!current || current.completedAt) return true
          if (JSON.stringify(current.items) !== JSON.stringify(row.items) || JSON.stringify(current.results) !== JSON.stringify(row.results)) return false
          await tx.itemSession.update({
            where: { id: sessionId },
            data: {
              items: asJson(next.items),
              results: asJson(next.meta),
              topicIds: [...new Set([...row.topicIds, ...next.items.map((i) => i.topicId)])],
              ...(next.finished ? { completedAt: now } : {}),
            },
          })
          return true
        },
        { timeout: 20_000, maxWait: 15_000 }
      )
      if (written) return
    }
    // Not an error for the student (the next read does the work again) but worth knowing about.
    console.warn(`Review session ${sessionId} changed under every attempt to advance it; the next read tries again.`)
  } finally {
    await sendJobs(toSend)
  }
}

// ------------------------------------------------------------------------------------------ reading

function summaryOf(items: SessionItem[], meta: SessionMeta, names: Map<string, string>, kind: SessionKind): SessionSummary {
  const graded = items.map((item, i) => ({ item, result: meta.graded[String(i)] })).filter((entry) => entry.result)
  const firstPass = graded.filter((entry) => entry.item.phase !== 'retest')
  const retests = graded.filter((entry) => entry.item.phase === 'retest')
  const missed = new Set(firstPass.filter((entry) => entry.result.score < SUCCESS).flatMap((entry) => entry.item.conceptIds))
  const retestRight = new Set(retests.filter((entry) => entry.result.score >= SUCCESS).flatMap((entry) => entry.item.conceptIds))
  const retested = new Set(retests.flatMap((entry) => entry.item.conceptIds))
  const named = (ids: Iterable<string>) => [...ids].flatMap((id) => names.get(id) ?? [])
  const unretested = [...missed].filter((id) => !retested.has(id))
  const leftOnPurpose = meta.retestCap !== undefined && retests.length >= meta.retestCap
  return {
    total: firstPass.length,
    correct: firstPass.filter((entry) => entry.result.score >= SUCCESS).length,
    retests: { total: retests.length, correct: retests.filter((entry) => entry.result.score >= SUCCESS).length },
    recovered: named([...missed].filter((id) => retestRight.has(id))),
    stillShaky: named([...missed].filter((id) => retested.has(id) && !retestRight.has(id))),
    // A drill has no closing retest, so it never says one was missing (spec 7.4).
    notRetested: kind === 'drill' || leftOnPurpose ? [] : named(unretested),
    // A short session's cap reached (or no retests at all): the rest were left out by design, not for want of a question.
    leftOut: kind === 'drill' || !leftOnPurpose ? [] : named(unretested),
    retestLimit: kind === 'review' && meta.retestCap !== undefined ? meta.retestCap : null,
    helpAfterMiss: null,
  }
}

/** The misses of a session: the concept ids of each missed item, by topic. A miss is a score under the success line, an "I don't know" included. */
function missedConceptsByTopic(items: SessionItem[], meta: SessionMeta): Map<string, Set<string>> {
  const byTopic = new Map<string, Set<string>>()
  items.forEach((item, index) => {
    const graded = meta.graded[String(index)]
    if (!graded || graded.score >= SUCCESS) return
    const set = byTopic.get(item.topicId) ?? new Set<string>()
    for (const id of item.conceptIds) set.add(id)
    byTopic.set(item.topicId, set)
  })
  return byTopic
}

/**
 * What to look at for everything missed so far (spec 18.5): `helpAfterMiss` for the missed concepts of each topic, merged.
 * Pointers come from stored claims, so this works with the AI down. Null when nothing was missed or it could not be read: the
 * session is still shown.
 */
async function missHelp(row: { userId: string; kind: string }, items: SessionItem[], meta: SessionMeta): Promise<HelpAfterMiss | null> {
  const byTopic = missedConceptsByTopic(items, meta)
  if (byTopic.size === 0) return null
  try {
    const merged: HelpAfterMiss = { pointers: [], explainer: null, easierStep: null }
    for (const [topicId, conceptIds] of byTopic) {
      const help = await helpAfterMiss(prisma, { userId: row.userId, topicId, conceptIds: [...conceptIds], surface: row.kind === 'drill' ? 'drill' : 'review' })
      for (const pointer of help.pointers) if (!merged.pointers.some((p) => p.conceptId === pointer.conceptId)) merged.pointers.push(pointer)
      merged.explainer ??= help.explainer
      merged.easierStep ??= help.easierStep
    }
    return merged
  } catch (error) {
    console.error('Help after a missed review item failed:', error)
    return null
  }
}

/** Misses that will come back once at the end and are not served yet (review only, and within the retest cap). */
function retestsToCome(kind: SessionKind, items: SessionItem[], meta: SessionMeta): number {
  if (kind !== 'review' || meta.retestsBuilt) return 0
  const missed = new Set<string>()
  items.forEach((item, index) => {
    const graded = meta.graded[String(index)]
    if (!graded || item.phase === 'retest' || graded.score >= SUCCESS) return
    for (const id of item.conceptIds) missed.add(id)
  })
  const retested = new Set(items.filter((item) => item.phase === 'retest').flatMap((item) => item.conceptIds))
  const count = [...missed].filter((id) => !retested.has(id)).length
  return meta.retestCap === undefined ? count : Math.min(count, meta.retestCap)
}

function titleOf(kind: SessionKind, meta: SessionMeta, topicNames: Map<string, string>, names: Map<string, string>): string {
  if (meta.scope.from === 'exam') return 'What you missed on the exam'
  if (kind === 'drill') return meta.scope.conceptId ? (names.get(meta.scope.conceptId) ?? 'Drill') : 'Drill'
  return meta.scope.topicId ? (topicNames.get(meta.scope.topicId) ?? "Today's review") : "Today's review"
}

async function nameLookups(projectId: string): Promise<{ topicNames: Map<string, string>; conceptNames: Map<string, string> }> {
  const [topics, concepts] = await Promise.all([
    prisma.topic.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.concept.findMany({ where: { projectId }, select: { id: true, name: true } }),
  ])
  return {
    topicNames: new Map(topics.map((t) => [t.id, t.name])),
    conceptNames: new Map(concepts.map((c) => [c.id, c.name])),
  }
}

/** The session as the browser sees it. Advances it first, so a poll is how finished jobs get picked up. */
export async function sessionView(userId: string, sessionId: string, timeZone: string): Promise<SessionView | null> {
  const exists = await prisma.itemSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } })
  if (!exists) return null
  await advance(userId, sessionId, timeZone)
  const row = await prisma.itemSession.findFirst({ where: { id: sessionId, userId } })
  if (!row) return null
  return toView(row)
}

async function toView(row: { id: string; userId: string; kind: string; projectId: string; items: Prisma.JsonValue; results: Prisma.JsonValue; completedAt: Date | null }): Promise<SessionView> {
  const meta = readMeta(row.results)
  const items = readItems(row.items)
  const { topicNames, conceptNames } = await nameLookups(row.projectId)
  const kind: SessionKind = row.kind === 'drill' ? 'drill' : 'review'

  const publicItems: PublicSessionItem[] = items.map((item, index) => ({
    index,
    phase: item.phase,
    topicId: item.topicId,
    topicName: topicNames.get(item.topicId) ?? '',
    conceptNames: item.conceptIds.flatMap((id) => conceptNames.get(id) ?? []),
    question: toPublicQuestion(item.question),
  }))
  const help = await missHelp(row, items, meta)
  const pointerOf = new Map((help?.pointers ?? []).map((pointer) => [pointer.conceptId, pointer]))
  const answered: Record<string, PublicAnswered> = {}
  for (const [index, graded] of Object.entries(meta.graded)) {
    const pointers = graded.score >= SUCCESS ? [] : (items[Number(index)]?.conceptIds ?? []).flatMap((id) => pointerOf.get(id) ?? [])
    answered[index] = {
      answer: graded.answer,
      ...(graded.idk ? { idk: true } : {}),
      ...(pointers.length > 0 ? { pointers } : {}),
      ...(graded.confidence !== undefined ? { confidence: graded.confidence } : {}),
      ...(graded.thinking ? { thinking: graded.thinking } : {}),
      correct: graded.correct,
      review: graded.review,
    }
  }

  let status: SessionStatus
  if (row.completedAt) status = 'complete'
  else if (meta.failure && items.length === 0) status = 'failed'
  else if (meta.pending.length > 0 && (items.length === 0 || firstUnanswered(items.length, answered) === null)) status = 'preparing'
  else status = 'active'

  return {
    id: row.id,
    kind,
    status,
    title: titleOf(kind, meta, topicNames, conceptNames),
    items: publicItems,
    answered,
    next: firstUnanswered(items.length, answered),
    message: meta.failure,
    summary: row.completedAt ? { ...summaryOf(items, meta, conceptNames, kind), helpAfterMiss: help } : null,
    retestsToCome: retestsToCome(kind, items, meta),
    short: meta.short === true,
    closingRetests: kind === 'review' && meta.retestCap !== 0,
  }
}

// ------------------------------------------------------------------------------------------ answering

export type AnswerResult =
  | { status: 'ok'; view: SessionView }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string }

/**
 * Grades one answer, writes its evidence and stores the result. The student answers the items in order;
 * an item answered already returns the stored result (a double click grades once). Grading errors
 * (`GradingUnavailableError`, `GradingRejectedError`) reach the caller untouched.
 */
export async function answerItem(input: {
  userId: string
  sessionId: string
  index: number
  answer: unknown
  timeZone: string
}): Promise<AnswerResult> {
  const { userId, sessionId, index, timeZone } = input
  const row = await prisma.itemSession.findFirst({ where: { id: sessionId, userId } })
  if (!row) return { status: 'not_found' }
  const items = readItems(row.items)
  const meta = readMeta(row.results)
  const item = items[index]
  if (!item) return { status: 'invalid', message: 'There is no such question in this session.' }
  if (meta.graded[String(index)]) return { status: 'ok', view: await toView(row) }
  if (row.completedAt) return { status: 'invalid', message: 'This session is finished.' }
  if (index !== firstUnanswered(items.length, meta.graded)) return { status: 'invalid', message: 'Answer the questions in order.' }

  const given = normalizeAnswers({ '0': input.answer })['0']
  if (!given || !isAnswered(given)) return { status: 'invalid', message: 'Give an answer first.' }

  // "I don't know" is a miss with nothing to grade: no grader call, and it works with the AI down (spec 18.3).
  const points = typeof item.question.points === 'number' && item.question.points > 0 ? item.question.points : 1
  const result = given.idk
    ? { question_index: 0, question_type: String(item.question.question_type ?? ''), points_possible: points, points_earned: 0, is_correct: false, feedback: '', needs_review: false }
    : (await gradeAnswers({ userId: input.userId, projectId: row.projectId }, [item.question], answersForGrader({ '0': given }))).graded_questions[0]
  if (!result) return { status: 'invalid', message: 'This question could not be graded.' }

  const source: 'review' | 'drill' = row.kind === 'drill' ? 'drill' : 'review'
  const known = new Set(
    (await prisma.concept.findMany({ where: { id: { in: item.conceptIds }, projectId: row.projectId, status: 'active' }, select: { id: true } })).map((c) => c.id)
  )
  const events = buildGradedEvidence(
    {
      userId,
      projectId: row.projectId,
      source,
      // A closing retest is its own rating: it moves q and the misconception, not the day's FSRS review (spec §7.4).
      sessionKey: item.phase === 'retest' ? `${source}:${sessionId}:retest` : `${source}:${sessionId}`,
      itemKeyOf: () => item.itemKey,
      topicOf: () => item.topicId,
    },
    { questions: [item.question], answers: { '0': given as QuizAnswer }, graded: [{ ...result, question_index: 0 }], knownConceptIds: known }
  )

  const score = result.points_possible > 0 ? Math.min(1, Math.max(0, result.points_earned / result.points_possible)) : result.is_correct ? 1 : 0
  const review = buildReview([item.question], toStoredResults([{ ...result, question_index: 0 }], dontKnowIndexes({ '0': given as QuizAnswer })), { '0': given.answer })[0]
  const storeResult = async (tx: Prisma.TransactionClient) => {
    await lockSession(tx, sessionId)
    const fresh = await tx.itemSession.findFirst({ where: { id: sessionId, userId } })
    if (!fresh) return
    const freshMeta = readMeta(fresh.results)
    if (freshMeta.graded[String(index)]) return
    freshMeta.graded[String(index)] = {
      answer: given.answer,
      ...(given.idk ? { idk: true } : {}),
      ...(given.confidence !== undefined ? { confidence: given.confidence } : {}),
      ...(given.thinking ? { thinking: given.thinking } : {}),
      score,
      correct: score >= SUCCESS,
      review: { ...review, questionIndex: index },
    }
    const answers = isRecord(fresh.answers) ? { ...fresh.answers } : {}
    answers[String(index)] = given
    await tx.itemSession.update({ where: { id: sessionId }, data: { results: asJson(freshMeta), answers: asJson(answers) } })
  }
  // The evidence and the stored result commit together (and the evidence is idempotent, skipIfPresent, so an answer
  // sent again after a failure writes nothing twice).
  if (events.length > 0) await recordEvidence(events, { timeZone, userId, skipIfPresent: true, inTransaction: storeResult })
  else await prisma.$transaction(storeResult)

  const view = await sessionView(userId, sessionId, timeZone)
  return view ? { status: 'ok', view } : { status: 'not_found' }
}

/**
 * "Skip for now": moves the next question to the end of the session, with no evidence, for a student who
 * cannot have it graded right now (a short answer while the AI is away). Only the next unanswered item can
 * be skipped, and not the last one left, so everything answered keeps its place and the item still has to
 * be answered before the session ends.
 */
export async function skipItem(input: { userId: string; sessionId: string; index: number; timeZone: string }): Promise<AnswerResult> {
  const { userId, sessionId, index, timeZone } = input
  const outcome = await prisma.$transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const row = await tx.itemSession.findFirst({ where: { id: sessionId, userId } })
    if (!row) return 'not_found' as const
    const meta = readMeta(row.results)
    const items = readItems(row.items)
    if (row.completedAt || index !== firstUnanswered(items.length, meta.graded)) return 'order' as const
    if (index >= items.length - 1) return 'last' as const
    const [item] = items.splice(index, 1)
    items.push(item)
    // Only unanswered items move, so the graded results keep their positions.
    await tx.itemSession.update({ where: { id: sessionId }, data: { items: asJson(items) } })
    return 'ok' as const
  })
  if (outcome === 'not_found') return { status: 'not_found' }
  if (outcome === 'order') return { status: 'invalid', message: 'Only the next question can be skipped.' }
  if (outcome === 'last') return { status: 'invalid', message: 'This is the last question left, so it cannot be skipped.' }
  const view = await sessionView(userId, sessionId, timeZone)
  return view ? { status: 'ok', view } : { status: 'not_found' }
}
