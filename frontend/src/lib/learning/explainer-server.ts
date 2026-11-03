/**
 * The explainer (spec §5.4): the AI lesson, behind a gate. Server only.
 *
 * - Gate. The explainer is open once a level-0 recall has set `recallAt`, once the student asked for it with "I'd rather read an
 *   explanation now" (`explainerUnlockReason = 'asked'`, which needs `readAt`), and for a topic that has no recall to do (no concept
 *   with a claim: a course from before v3, or extraction that failed): such a topic must not stay locked, and its
 *   explainer is the old lesson notes. The same stages as the next-activity selector are read (stage-inference.ts).
 * - Gap form. Each recall attempt with a missing or incorrect claim gets a `gap_explainer` job; its answer is stored on
 *   `RecallAttempt.explainer`. The page shows the gaps of the newest attempt of each card.
 * - A visit (`explainer.viewedAt`, which next-activity reads) is recorded on those attempts when the student opens it.
 * - A section of the explainer scrolling into view is instruction on its concept (`explainerViewed`, spec 18.5).
 * - A "check yourself" block graded by the student is level-2 evidence, `source=example`, for display only.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db/prisma'
import { blockedCode } from '@/lib/ai/status'
import { createJobOrFindActive, gapExplainerTarget, ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'
import { enqueueGapExplainerJob, TaskEnqueueError } from '@/lib/tasks/dispatch'
import { checkScore, type CheckGrade } from '@/lib/reader/checks'
import { getAiStatus } from '@/server/ai-status'
import { recordEvidence } from './evidence'
import { recordInstruction } from './instruction-server'
import { inferStages } from './stage-inference'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

// ------------------------------------------------------------------------------------------ the gate

export type ExplainerAccess = {
  /** The explainer may be shown. */
  open: boolean
  /** Why it is open: a level-0 recall, the student asked for it ("I'd rather read an explanation now"), or a topic with nothing to recall. */
  why: 'recalled' | 'unlocked' | 'no_recall' | null
  /** "I'd rather read an explanation now" is offered: the topic has been read. */
  canUnlock: boolean
}

/**
 * Whether the student can do a recall on this topic. The Recall step is offered only once the topic's history is
 * converted to evidence (`evidenceBackfilledAt`, the switch the path and mastery use) and it has a card, which needs an
 * active concept with a claim to grade against. Anything less and "Start recall" would lead nowhere, so the explainer is open.
 */
export async function hasRecallPath(topicId: string): Promise<boolean> {
  return (await prisma.conceptClaim.count({ where: { concept: { topicId, status: 'active', topic: { evidenceBackfilledAt: { not: null } } } } })) > 0
}

/**
 * Whether the topic has a claim to recall against at all, whether or not its history has been converted yet. The
 * explainer's gate reads this one: a conversion that is slow (or has not run) must not open a lesson that recall is
 * meant to come before. Recall is simply not offered until the conversion is done.
 */
async function hasClaims(topicId: string): Promise<boolean> {
  return (await prisma.conceptClaim.count({ where: { concept: { topicId, status: 'active' } } })) > 0
}

/** Where the explainer gate stands for this student; null when the topic is not theirs. */
export async function explainerAccess(userId: string, topicId: string): Promise<ExplainerAccess | null> {
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true } })
  if (!topic) return null
  const progress = await prisma.topicProgress.findUnique({ where: { topicId_userId: { topicId, userId } } })
  if (progress?.explainerUnlockedAt) return { open: true, why: 'unlocked', canUnlock: true }
  // Legacy evidence is looked up only when it can matter: a topic read before v3, with no recall recorded.
  const legacy = progress?.notesCompleted === true && !progress.readAt && !progress.recallAt
  const hasAnyEvidence = legacy
    ? (await prisma.evidenceEvent.count({ where: { userId, topicId, source: { notIn: ['implicit', 'warmup', 'reader', 'instruction'] } } })) > 0 ||
      (await prisma.quizAttempt.count({ where: { userId, topicId } })) > 0 ||
      progress?.quizCompleted === true
    : false
  const { readAt, recallAt } = inferStages(progress, hasAnyEvidence)
  if (recallAt) return { open: true, why: 'recalled', canUnlock: true }
  if (!(await hasClaims(topicId))) return { open: true, why: 'no_recall', canUnlock: true }
  return { open: false, why: null, canUnlock: readAt !== null }
}

export type UnlockResult = { status: 'ok' } | { status: 'not_found' } | { status: 'read_first' }

/** "I'd rather read an explanation now" (spec 18.10). Needs the topic to have been read; recorded as `asked`. */
export async function unlockExplainer(input: { userId: string; topicId: string }): Promise<UnlockResult> {
  const { userId, topicId } = input
  const access = await explainerAccess(userId, topicId)
  if (!access) return { status: 'not_found' }
  if (access.open) return { status: 'ok' }
  if (!access.canUnlock) return { status: 'read_first' }
  const now = new Date()
  await prisma.topicProgress.upsert({ where: { topicId_userId: { topicId, userId } }, create: { topicId, userId, explainerUnlockedAt: now, explainerUnlockReason: 'asked' }, update: {} })
  // Set once, whoever gets here first.
  await prisma.topicProgress.updateMany({ where: { topicId, userId, explainerUnlockedAt: null }, data: { explainerUnlockedAt: now, explainerUnlockReason: 'asked' } })
  return { status: 'ok' }
}

// ------------------------------------------------------------------------------------------ gap explanations

export type GapSource = { materialId: string | null; filename: string; page: number | null }
export type GapView = {
  claimId: string
  conceptId: string
  conceptName: string
  explanation: string
  check: { question: string; answer: string }
  source: GapSource
}
export type SkippedGap = { claimId: string; conceptName: string; source: GapSource }

export type GapExplainerState = {
  /** none: the recall left no gaps (or none was done). pending: still being written. failed: not written. ready: all written. */
  status: 'none' | 'pending' | 'failed' | 'ready'
  gaps: GapView[]
  skipped: SkippedGap[]
  /** Attempts whose explainer is missing and no job is working on it: "Write them again" starts these. */
  missing: string[]
}

type StoredGap = { claim_id?: unknown; concept_id?: unknown; concept_name?: unknown; explanation?: unknown; check?: unknown; source?: unknown; page?: unknown }

function readSource(value: unknown): GapSource {
  const source = isRecord(value) ? value : {}
  return { materialId: text(source.material_id), filename: text(source.filename) ?? 'your pages', page: typeof source.page === 'number' ? source.page : null }
}

/** The claims a graded recall answer left missing or incorrect. */
export function gapClaimIds(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.claims)) return []
  return result.claims.flatMap((claim) => {
    if (!isRecord(claim) || (claim.verdict !== 'missing' && claim.verdict !== 'incorrect')) return []
    const id = text(claim.claim_id)
    return id ? [id] : []
  })
}

/** The concepts a recall attempt's written gap explainer covers; none while it is missing or still being written. */
export function writtenGapConcepts(explainer: unknown): string[] {
  return [...new Set(readExplainer(explainer).gaps.map((gap) => gap.conceptId).filter((id) => id !== ''))]
}

function readExplainer(explainer: unknown): { ready: boolean; gaps: GapView[]; skipped: SkippedGap[] } {
  if (!isRecord(explainer) || explainer.status !== 'ready') return { ready: false, gaps: [], skipped: [] }
  const gaps = (Array.isArray(explainer.gaps) ? (explainer.gaps as StoredGap[]) : []).flatMap((gap): GapView[] => {
    if (!isRecord(gap)) return []
    const check = isRecord(gap.check) ? gap.check : {}
    const claimId = text(gap.claim_id)
    const explanation = text(gap.explanation)
    const question = text(check.question)
    const answer = text(check.answer)
    if (!claimId || !explanation || !question || !answer) return []
    return [{ claimId, conceptId: text(gap.concept_id) ?? '', conceptName: text(gap.concept_name) ?? '', explanation, check: { question, answer }, source: readSource(gap.source) }]
  })
  const skipped = (Array.isArray(explainer.skipped) ? explainer.skipped : []).flatMap((item): SkippedGap[] => {
    if (!isRecord(item)) return []
    const claimId = text(item.claim_id)
    return claimId ? [{ claimId, conceptName: text(item.concept_name) ?? '', source: readSource(item.source) }] : []
  })
  return { ready: true, gaps, skipped }
}

/**
 * The newest graded recall attempt of each card (an objective, or the whole topic). An answer given with the reading open
 * was not a recall and is left out, so it neither gets an explainer nor hides the gaps of the attempt before it.
 */
export async function newestAttempts(userId: string, topicId: string) {
  const rows = await prisma.recallAttempt.findMany({
    where: { userId, topicId, kind: 'recall' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, objectiveIndex: true, result: true, explainer: true, createdAt: true },
  })
  // Newest first, so the first of each card is its newest.
  const seen = new Set<number | null>()
  return rows.filter((row) => {
    if (isRecord(row.result) && row.result.abandoned === true) return false
    if (seen.has(row.objectiveIndex)) return false
    seen.add(row.objectiveIndex)
    return true
  })
}

/** An attempt answered this recently with no explainer and no job yet: its job is being started, not lost. */
const STARTING_MS = 90_000

/** The explanations of what the newest recall answers missed, and whether they are still being written. */
export async function loadGapExplainer(userId: string, topicId: string): Promise<GapExplainerState> {
  const withGaps = (await newestAttempts(userId, topicId)).filter((attempt) => gapClaimIds(attempt.result).length > 0)
  if (withGaps.length === 0) return { status: 'none', gaps: [], skipped: [], missing: [] }

  const jobs = await prisma.processingJob.findMany({
    where: { userId, jobType: 'gap_explainer', targetKey: { in: withGaps.map((attempt) => gapExplainerTarget(attempt.id)) }, status: { in: ACTIVE_JOB_STATUSES } },
    select: { targetKey: true },
  })
  const running = new Set(jobs.map((job) => job.targetKey))

  const gaps = new Map<string, GapView>()
  const skipped = new Map<string, SkippedGap>()
  const missing: string[] = []
  let pending = false
  for (const attempt of withGaps) {
    const read = readExplainer(attempt.explainer)
    if (read.ready) {
      for (const gap of read.gaps) gaps.set(gap.claimId, gap)
      for (const item of read.skipped) skipped.set(item.claimId, item)
    } else if (running.has(gapExplainerTarget(attempt.id)) || Date.now() - attempt.createdAt.getTime() < STARTING_MS) {
      pending = true
    } else {
      missing.push(attempt.id)
    }
  }
  const status = pending ? 'pending' : missing.length > 0 ? 'failed' : 'ready'
  return { status, gaps: [...gaps.values()], skipped: [...skipped.values()], missing }
}

export type StartResult = { status: 'started' | 'running' | 'none' } | { status: 'not_found' } | { status: 'blocked'; code: string }

/**
 * Starts the gap explainer of one recall attempt, unless it has no gap or is written. With `quiet` (right after a
 * recall answer) an unavailable AI is not an error: the explainer page offers to write them later.
 */
export async function startGapExplainer(input: { userId: string; attemptId: string; quiet?: boolean }): Promise<StartResult> {
  const { userId, attemptId } = input
  const attempt = await prisma.recallAttempt.findFirst({
    where: { id: attemptId, userId },
    select: { id: true, result: true, explainer: true, topic: { select: { projectId: true } } },
  })
  if (!attempt) return { status: 'not_found' }
  if (gapClaimIds(attempt.result).length === 0 || readExplainer(attempt.explainer).ready) return { status: 'none' }
  const blocked = blockedCode(await getAiStatus(userId))
  if (blocked) return { status: 'blocked', code: blocked }

  const { job, created } = await createJobOrFindActive({
    userId,
    projectId: attempt.topic.projectId,
    jobType: 'gap_explainer',
    status: 'pending',
    stage: 'generating',
    inputData: { attemptId },
    progressPercent: 0,
    targetKey: gapExplainerTarget(attemptId),
  })
  if (!created) return { status: 'running' }
  try {
    await enqueueGapExplainerJob(job.id, attemptId)
  } catch (error) {
    const retryable = error instanceof TaskEnqueueError ? error.retryable : true
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT', errorMessage: 'Failed to enqueue the gap explanations', retryable, completedAt: new Date() },
    })
    if (!input.quiet) throw error
  }
  return { status: 'started' }
}

/** Starts the explainer of every attempt that has none (the "Write them again" button). */
export async function startMissingGapExplainers(userId: string, topicId: string): Promise<StartResult> {
  const state = await loadGapExplainer(userId, topicId)
  if (state.missing.length === 0) return { status: state.status === 'pending' ? 'running' : 'none' }
  let outcome: StartResult = { status: 'none' }
  for (const attemptId of state.missing) {
    const result = await startGapExplainer({ userId, attemptId })
    if (result.status === 'blocked' || result.status === 'not_found') return result
    if (result.status === 'started' || outcome.status === 'none') outcome = result
  }
  return outcome
}

/** The explainer was opened: the newest attempt of each card gets a `viewedAt` (the first visit stands). */
export async function markExplainerViewed(userId: string, topicId: string): Promise<void> {
  const attempts = await newestAttempts(userId, topicId)
  const viewedAt = new Date().toISOString()
  for (const attempt of attempts) {
    if (isRecord(attempt.explainer) && typeof attempt.explainer.viewedAt === 'string') continue
    // Merged into the stored explainer, so a gap explainer written meanwhile is kept (the job merges the same way).
    await prisma.$executeRaw`
      UPDATE recall_attempts
      SET explainer = COALESCE(explainer, '{}'::jsonb) || ${JSON.stringify({ viewedAt })}::jsonb
      WHERE id = ${attempt.id} AND (explainer IS NULL OR explainer->>'viewedAt' IS NULL)`
  }
}

/**
 * A section of the explainer scrolled into view: instruction on its concept (spec 18.5), `gap_explainer` for the gap
 * form and `full_explainer` for the lesson. One event per concept per local day. The concepts come from the gap section
 * itself (`conceptIds`) or, for a lesson section, from its heading: the one concept the heading names, else none.
 * Returns how many events were written; concepts that are not the student's own are dropped.
 */
export async function explainerViewed(
  userId: string,
  topicId: string,
  input: { kind: 'gap_explainer' | 'full_explainer'; conceptIds?: string[]; heading?: string; timeZone?: string }
): Promise<number> {
  let conceptIds = input.conceptIds ?? []
  if (conceptIds.length === 0 && input.heading) {
    const concepts = await prisma.concept.findMany({ where: { topicId, status: 'active', topic: { project: { userId } } }, select: { id: true, name: true } })
    conceptIds = conceptsNamedIn(input.heading, concepts)
  }
  let written = 0
  for (const conceptId of new Set(conceptIds)) {
    const result = await recordInstruction(prisma, { userId, topicId, kind: input.kind, conceptIds: [conceptId], ref: conceptId, timeZone: input.timeZone })
    if (result.status === 'recorded') written += 1
  }
  return written
}

// ------------------------------------------------------------------------------------------ check blocks

/** The item a check block is known by: the topic and its question, so a page reopened later is the same item. */
export function checkItemKey(topicId: string, question: string): string {
  const digest = createHash('sha256').update(question.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 16)
  return `example:${topicId}:${digest}`
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The one concept a lesson question names: its name as a whole word, in any case. A name inside a longer word does not
 * count, a name inside a longer matching name is the longer one's, and two different concepts named make the question
 * ambiguous: it is not filed under either.
 */
export function conceptsNamedIn(question: string, concepts: { id: string; name: string }[]): string[] {
  const named = concepts
    .map((concept) => ({ id: concept.id, name: concept.name.trim() }))
    .filter((concept) => concept.name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(concept.name)}(?![\\p{L}\\p{N}])`, 'iu').test(question))
  const outer = named.filter((a) => !named.some((b) => b !== a && b.name.length > a.name.length && b.name.toLowerCase().includes(a.name.toLowerCase())))
  return outer.length === 1 ? [outer[0].id] : []
}

export type CheckInput = {
  userId: string
  topicId: string
  question: string
  grade: CheckGrade
  idk: boolean
  conceptId: string | null
  /** The concepts a worked example's step is about; the grade is filed under all of them. Wins over `conceptId` and names. */
  conceptIds?: string[]
  timeZone: string
}
export type CheckResult = { status: 'ok'; recorded: boolean } | { status: 'not_found' }

/**
 * A check block graded by the student: level 2, self-graded, for display (spec §3.3). The concept is the one the gap
 * explanation is about, or those a worked example lists; a check in the lesson notes belongs to the concepts of this
 * topic that its question names.
 * A question that names none is not filed under any. The first grade of a question stands. A concept that was merged
 * since the content was written is filed under the one it became; an archived one is left out, and when none remain the
 * answer is not counted.
 */
export async function recordExplainerCheck(input: CheckInput): Promise<CheckResult> {
  const { userId, topicId } = input
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true, projectId: true } })
  if (!topic) return { status: 'not_found' }
  const all = await prisma.concept.findMany({ where: { topicId }, select: { id: true, name: true, status: true, mergedIntoId: true } })
  const concepts = all.filter((concept) => concept.status === 'active')
  const byId = new Map(all.map((concept) => [concept.id, concept]))
  // Stored example content can name a concept that was archived or merged since: a merged one is filed under what it
  // became, an archived one is dropped. An id that is not this topic's at all is still refused.
  const resolveId = (id: string): string | null => {
    let current = byId.get(id)
    for (let hops = 0; current && hops < 5; hops++) {
      if (current.status === 'active') return current.id
      current = current.mergedIntoId ? byId.get(current.mergedIntoId) : undefined
    }
    return null
  }
  let conceptIds: string[]
  if (input.conceptIds && input.conceptIds.length > 0) {
    if (!input.conceptIds.every((id) => byId.has(id))) return { status: 'not_found' }
    conceptIds = [...new Set(input.conceptIds.map(resolveId).filter((id): id is string => id !== null))]
  } else if (input.conceptId) {
    if (!byId.has(input.conceptId)) return { status: 'not_found' }
    const resolved = resolveId(input.conceptId)
    conceptIds = resolved ? [resolved] : []
  } else {
    conceptIds = conceptsNamedIn(input.question, concepts)
  }
  if (conceptIds.length === 0) return { status: 'ok', recorded: false }

  const itemKey = checkItemKey(topicId, input.question)
  if (await prisma.evidenceEvent.findFirst({ where: { userId, itemKey, source: 'example' }, select: { id: true } })) return { status: 'ok', recorded: false }
  await recordEvidence(
    [
      {
        userId,
        projectId: topic.projectId,
        topicId,
        itemKey,
        conceptIds,
        source: 'example',
        // "I don't know" is a miss whatever grade was sent.
        score: input.idk ? 0 : checkScore(input.grade),
        assistance: 2,
        gradedBy: 'self',
        sessionKey: `explainer:${topicId}`,
        metadata: { grade: input.idk ? 'missed' : input.grade, ...(input.idk ? { idk: true } : {}) },
      },
    ],
    { timeZone: input.timeZone, userId, skipIfPresent: true }
  )
  return { status: 'ok', recorded: true }
}

/**
 * The gap explanations were shown for the first time: the AI told the student what they missed, so each concept of a
 * rendered gap carries level 3 (no review, no score; a card that exists comes due by tomorrow), once per attempt, as
 * "Show me what I missed" does (spec §3.3). Nothing is written for the full explainer. Returns how many attempts were stamped.
 */
export async function recordGapsShown(input: { userId: string; topicId: string; timeZone: string }): Promise<number> {
  const { userId, topicId } = input
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { projectId: true } })
  if (!topic) return 0
  let stamped = 0
  for (const attempt of await newestAttempts(userId, topicId)) {
    const read = readExplainer(attempt.explainer)
    const shown = isRecord(attempt.explainer) && typeof attempt.explainer.gapsShownAt === 'string'
    if (!read.ready || shown || read.gaps.length === 0) continue
    const conceptIds = [...new Set(read.gaps.map((gap) => gap.conceptId).filter(Boolean))]
    if (conceptIds.length > 0) {
      await recordEvidence(
        conceptIds.map((conceptId) => ({
          userId,
          projectId: topic.projectId,
          topicId,
          itemKey: `example:${topicId}:gaps:${attempt.id}`,
          conceptIds: [conceptId],
          source: 'example' as const,
          score: 0,
          assistance: 3 as const,
          gradedBy: 'rule' as const,
          sessionKey: `explainer-gaps:${attempt.id}`,
          metadata: { gapsShown: true, attemptId: attempt.id },
        })),
        { timeZone: input.timeZone, userId, skipIfPresent: true }
      )
    }
    await prisma.$executeRaw`
      UPDATE recall_attempts
      SET explainer = COALESCE(explainer, '{}'::jsonb) || ${JSON.stringify({ gapsShownAt: new Date().toISOString() })}::jsonb
      WHERE id = ${attempt.id} AND explainer->>'gapsShownAt' IS NULL`
    stamped += 1
  }
  return stamped
}

