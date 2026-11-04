import { prisma } from '@/lib/db/prisma'
import { blockedCode } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { conceptMastery, type ConceptKind } from './concept-mastery'
import { Rating } from 'ts-fsrs'
import { needsInstruction } from './instruction'
import { stateFromMemoryRow } from './mastery'
import { asQuestionList } from './quiz-questions'
import { inferStages } from './stage-inference'
import { newestAttempts, writtenGapConcepts } from './explainer-server'
import { localDateParts } from './study-plan-time'
import { studentTimeZone } from './student-time-zone'
import { UNKNOWN_BAND_INPUTS, bandInputsFromState, conceptBand } from './level'
import { activityWithHref, type NextActivity, type TopicConceptState, type TopicLearningState } from './next-activity'
import { loadPracticeState } from './practice-done'
import { warmupPriorByConcept } from './warmup-bracket'
import { latestWarmupResults } from './warmup-session'

/**
 * Gathers the state the next-activity cascade reads (spec §8.1) for one student and one topic.
 *
 * A topic uses concepts only once its history has been converted to evidence (Topic.evidenceBackfilledAt),
 * the same switch that moves its mastery onto concepts (lib/learning/mastery.ts). Before that, and for a
 * topic whose extraction failed or has not run, `concepts` is empty and the cascade keeps the old path.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const latest = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((best, date) => (date && (!best || date > best) ? date : best), null)

/**
 * The concepts a recall attempt left with a missing or incorrect claim. The grader's result lists its
 * verdict per claim; an unreadable result has no gaps.
 */
export function recallGapConcepts(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.claims)) return []
  const gaps = new Set<string>()
  for (const claim of result.claims) {
    if (!isRecord(claim)) continue
    const id = claim.concept_id ?? claim.conceptId
    const verdict = claim.verdict
    if (typeof id === 'string' && (verdict === 'missing' || verdict === 'incorrect')) gaps.add(id)
  }
  return [...gaps]
}

/**
 * The concepts still left with a gap after a student's recall attempts, newest first. A recall has a card per
 * objective, so the gaps are read across the cards: each concept is judged by the newest attempt that covered
 * it, and a gap closed by a later attempt is gone.
 */
export function latestRecallGaps(results: unknown[]): string[] {
  const decided = new Set<string>()
  const gaps: string[] = []
  for (const result of results) {
    if (!isRecord(result) || !Array.isArray(result.claims)) continue
    const here = new Set<string>()
    for (const claim of result.claims) {
      if (!isRecord(claim)) continue
      const id = claim.concept_id ?? claim.conceptId
      if (typeof id === 'string' && id) here.add(id)
    }
    const open = new Set(recallGapConcepts(result))
    for (const id of here) {
      if (decided.has(id)) continue
      decided.add(id)
      if (open.has(id)) gaps.push(id)
    }
  }
  return gaps
}

/** A quiz set is a transfer quiz when every question in it is hard. */
export function isHardSet(questions: Record<string, unknown>[]): boolean {
  return questions.length > 0 && questions.every((q) => q.difficulty === 'hard')
}

type PrerequisiteEdge = { sourceId: string; targetId: string }

// A prerequisite under either line sends a struggling student to a drill on it (spec 8.1, rule 7).
const WEAK_PREREQUISITE_RETRIEVABILITY = 0.8
const WEAK_PREREQUISITE_MASTERY = 0.4

/**
 * The weakest prerequisite of each concept (lowest mastery now, then lowest retrievability), among all
 * its prerequisites whether or not they belong to this topic, and whether it is weak enough for a drill. A
 * prerequisite with no memory counts as 0.
 */
async function weakestPrerequisites(userId: string, edges: PrerequisiteEdge[], now: Date): Promise<Map<string, { id: string; weak: boolean }>> {
  const out = new Map<string, { id: string; weak: boolean }>()
  const ids = [...new Set(edges.map((e) => e.sourceId))]
  if (ids.length === 0) return out
  const [concepts, memories] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: ids }, status: 'active' }, select: { id: true, kind: true } }),
    prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: ids } } }),
  ])
  const kindOf = new Map(concepts.map((c) => [c.id, c.kind]))
  const memoryOf = new Map(memories.map((m) => [m.conceptId, m]))
  const score = (id: string) => {
    const memory = memoryOf.get(id)
    if (!memory) return { mastery: 0, retrievability: 0 }
    return conceptMastery(stateFromMemoryRow(memory), (kindOf.get(id) ?? 'concept') as ConceptKind, now)
  }
  const targets = new Set(edges.map((e) => e.targetId))
  for (const target of targets) {
    const options = edges.filter((e) => e.targetId === target && kindOf.has(e.sourceId)).map((e) => ({ id: e.sourceId, ...score(e.sourceId) }))
    options.sort((a, b) => a.mastery - b.mastery || a.retrievability - b.retrievability || a.id.localeCompare(b.id))
    const weakest = options[0]
    if (weakest) out.set(target, { id: weakest.id, weak: weakest.retrievability < WEAK_PREREQUISITE_RETRIEVABILITY || weakest.mastery < WEAK_PREREQUISITE_MASTERY })
  }
  return out
}

const localDayKey = (at: Date, timeZone: string): string => {
  const { year, month, day } = localDateParts(at, timeZone)
  return `${year}-${month}-${day}`
}

/**
 * The concepts that had an easier step after their last fail (spec 8.1, rule 7): a worked example delivered on them
 * (an instruction event of that kind), or a drill session scoped to them, created after `lastFailAt`. The rule cannot
 * repeat without a new fail.
 */
async function easierStepSince(userId: string, projectId: string, fails: Map<string, Date>): Promise<Set<string>> {
  const out = new Set<string>()
  if (fails.size === 0) return out
  const earliest = new Date(Math.min(...[...fails.values()].map((d) => d.getTime())))
  const [examples, drills] = await Promise.all([
    prisma.evidenceEvent.findMany({
      where: { userId, conceptId: { in: [...fails.keys()] }, source: 'instruction', itemKey: { startsWith: 'instruction:worked_example:' }, createdAt: { gte: earliest } },
      select: { conceptId: true, createdAt: true },
    }),
    prisma.itemSession.findMany({ where: { userId, projectId, kind: 'drill', createdAt: { gte: earliest } }, select: { results: true, createdAt: true } }),
  ])
  for (const event of examples) if (event.createdAt > (fails.get(event.conceptId) as Date)) out.add(event.conceptId)
  for (const session of drills) {
    const scope = isRecord(session.results) && isRecord(session.results.scope) ? session.results.scope : null
    const conceptId = scope && typeof scope.conceptId === 'string' ? scope.conceptId : null
    if (conceptId && fails.has(conceptId) && session.createdAt > (fails.get(conceptId) as Date)) out.add(conceptId)
  }
  return out
}

async function loadConcepts(userId: string, topicId: string, now: Date, timeZone: string): Promise<TopicConceptState[]> {
  const rows = await prisma.concept.findMany({
    where: { topicId, status: 'active' },
    orderBy: { orderIndex: 'asc' },
    select: { id: true, kind: true, name: true, projectId: true },
  })
  if (rows.length === 0) return []
  const ids = rows.map((c) => c.id)
  const [memories, edges, quizEvents, warmup, claims] = await Promise.all([
    prisma.conceptMemory.findMany({ where: { userId, conceptId: { in: ids } } }),
    prisma.conceptEdge.findMany({
      where: { type: 'prerequisite', status: { not: 'rejected' }, targetId: { in: ids } },
      select: { sourceId: true, targetId: true },
    }),
    prisma.evidenceEvent.findMany({
      where: { userId, conceptId: { in: ids }, source: 'quiz', assistance: 0 },
      distinct: ['conceptId'],
      select: { conceptId: true },
    }),
    latestWarmupResults(userId, topicId),
    prisma.conceptClaim.findMany({ where: { conceptId: { in: ids } }, orderBy: [{ conceptId: 'asc' }, { orderIndex: 'asc' }], select: { conceptId: true, chunkId: true, pageStart: true } }),
  ])
  const firstClaim = new Map<string, { page: number | null; chunkId: string | null }>()
  for (const claim of claims) if (!firstClaim.has(claim.conceptId)) firstClaim.set(claim.conceptId, { page: claim.pageStart, chunkId: claim.chunkId })
  const prior = warmupPriorByConcept(warmup ?? [])
  const memoryOf = new Map(memories.map((m) => [m.conceptId, m]))
  const quizzed = new Set(quizEvents.map((e) => e.conceptId))
  // Only concepts that have failed twice need their weakest prerequisite.
  const failing = new Set(rows.filter((c) => (memoryOf.get(c.id)?.consecutiveFails ?? 0) >= 2).map((c) => c.id))
  const weakest = await weakestPrerequisites(userId, edges.filter((e) => failing.has(e.targetId)), now)
  const states = new Map(memories.map((m) => [m.conceptId, stateFromMemoryRow(m)]))
  // Concepts that failed twice and whose last fail may have had an easier step since.
  const lastFails = new Map(
    [...failing].flatMap((id) => {
      const at = states.get(id)?.lastFailAt
      return at ? ([[id, at]] as const) : []
    })
  )
  const easier = await easierStepSince(userId, rows[0].projectId, lastFails)
  const today = localDayKey(now, timeZone)
  return rows.map((concept) => {
    const memory = memoryOf.get(concept.id)
    const replayed = states.get(concept.id) ?? null
    const scored = replayed
      ? conceptMastery(replayed, concept.kind as ConceptKind, now)
      : { mastery: 0, retrievability: 0, label: 'not_started' as const }
    const conceptPrior = prior.get(concept.id) ?? null
    const band = replayed
      ? conceptBand(bandInputsFromState(replayed, scored.retrievability, conceptPrior))
      : conceptBand({ ...UNKNOWN_BAND_INPUTS, prior: conceptPrior })
    return {
      id: concept.id,
      name: concept.name,
      mastery: scored.mastery,
      label: scored.label,
      retrievability: scored.retrievability,
      misconception: memory?.misconception ?? null,
      consecutiveFails: memory?.consecutiveFails ?? 0,
      nUnassisted: memory?.nUnassisted ?? 0,
      hasCard: replayed?.card != null,
      hasQuizEvidence: quizzed.has(concept.id),
      prerequisiteIds: edges.filter((e) => e.targetId === concept.id).map((e) => e.sourceId),
      band,
      needsInstruction: replayed ? needsInstruction(replayed) : false,
      easierStepSinceFail: easier.has(concept.id),
      // The latest rated group was on today's local day and graded Good or Easy (a group of failed first tries grades Again).
      latestGroupGoodToday:
        !!replayed &&
        replayed.latestGrade !== null &&
        replayed.latestGrade >= Rating.Good &&
        replayed.level0Scores.length > 0 &&
        localDayKey(replayed.level0Scores[replayed.level0Scores.length - 1].at, timeZone) === today,
      lastFailAt: replayed?.lastFailAt ?? null,
      firstClaim: firstClaim.get(concept.id) ?? null,
      weakestPrerequisiteId: weakest.get(concept.id)?.id ?? null,
      prerequisiteWeak: weakest.get(concept.id)?.weak ?? false,
    }
  })
}

/**
 * When the student last took a quiz set of all-hard questions, and whether such a set exists at all (so a harder quiz
 * can start without the model). Looks at every set, not a window of attempts.
 */
async function hardQuizState(userId: string, topicId: string): Promise<{ lastAt: Date | null; onHand: boolean }> {
  const sets = await prisma.topicQuiz.findMany({ where: { topicId, kind: { in: ['standard', 'retry'] } }, select: { id: true, questions: true } })
  const hard = sets.filter((s) => isHardSet(asQuestionList(s.questions) ?? [])).map((s) => s.id)
  if (hard.length === 0) return { lastAt: null, onHand: false }
  const attempt = await prisma.quizAttempt.findFirst({
    where: { userId, topicId, quizSetId: { in: hard } },
    orderBy: { takenAt: 'desc' },
    select: { takenAt: true },
  })
  return { lastAt: attempt?.takenAt ?? null, onHand: true }
}

type TopicRef = { id: string; unitId: string | null; confirmed: boolean }

/**
 * The one function that works out a topic's next activity, with its address, for every screen: the topic page, Home's
 * Continue card, the course overview's Up next and the plan all come here, so they agree. It reads the AI's status
 * (`getAiStatus`, cached 10 s) so an activity that needs the model is not offered while it is down (spec 18.9), and the
 * student's zone for "today". Pass `state` when the caller has loaded it already (the topic page does).
 */
export async function resolveTopicActivity(input: {
  userId: string
  courseId: string
  topicId: string
  topics: TopicRef[]
  listConfirmed: boolean
  state?: TopicLearningState
  now?: Date
  timeZone?: string
}): Promise<NextActivity & { href: string }> {
  const now = input.now ?? new Date()
  const timeZone = input.timeZone ?? (await studentTimeZone())
  const [state, status] = await Promise.all([
    input.state ?? loadTopicLearningState({ userId: input.userId, topicId: input.topicId, now, timeZone }),
    getAiStatus(input.userId),
  ])
  return activityWithHref(state, {
    ai: blockedCode(status) ? 'down' : 'up',
    now,
    timeZone,
    courseId: input.courseId,
    topicId: input.topicId,
    topics: input.topics,
    listConfirmed: input.listConfirmed,
  })
}

export async function loadTopicLearningState(input: {
  userId: string
  topicId: string
  now?: Date
  /** The student's zone, for "today" (the Good-today flag); read from the request when absent. */
  timeZone?: string
}): Promise<TopicLearningState> {
  const { userId, topicId } = input
  const now = input.now ?? new Date()
  const timeZone = input.timeZone ?? (await studentTimeZone())

  const newest = { orderBy: { createdAt: 'desc' as const }, select: { createdAt: true } }
  const [topic, progress, warmupBank, recalls, teachBackAttempt, hardQuiz, examEvent, teachBackEvent, anyEvidence, quizAttempts, nextReview, practice, writtenContent, conceptCount] =
    await Promise.all([
      prisma.topic.findUnique({ where: { id: topicId }, select: { evidenceBackfilledAt: true } }),
      prisma.topicProgress.findUnique({ where: { topicId_userId: { topicId, userId } } }),
      prisma.topicQuiz.count({ where: { topicId, kind: 'warmup' } }),
      // The newest answer to each card that was given with the book closed: the set the explainer's visit is written on too.
      newestAttempts(userId, topicId),
      prisma.recallAttempt.findFirst({ where: { userId, topicId, kind: 'teach_back' }, ...newest }),
      hardQuizState(userId, topicId),
      prisma.evidenceEvent.findFirst({ where: { userId, topicId, source: 'exam' }, ...newest }),
      prisma.evidenceEvent.findFirst({ where: { userId, topicId, source: 'teach_back' }, ...newest }),
      // The warm-up and the reader's own evidence (checks, explanations) come before a topic is studied: they do not show it was.
      prisma.evidenceEvent.count({ where: { userId, topicId, source: { notIn: ['implicit', 'warmup', 'reader', 'instruction'] } } }),
      prisma.quizAttempt.count({ where: { userId, topicId } }),
      prisma.conceptMemory.findFirst({ where: { userId, topicId, dueAt: { not: null }, concept: { status: 'active' } }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } }),
      loadPracticeState(userId, topicId),
      prisma.topicContent.count({ where: { topicId } }),
      prisma.concept.count({ where: { topicId, status: 'active' } }),
    ])

  // A topic uses concepts only after its history is converted (the switch mastery uses too).
  const concepts = topic?.evidenceBackfilledAt ? await loadConcepts(userId, topicId, now, timeZone) : []

  // Legacy evidence: a finished quiz counts for a topic that has none recorded as events.
  const hasAnyEvidence = anyEvidence > 0 || quizAttempts > 0 || progress?.quizCompleted === true

  const { readAt, recallAt } = inferStages(progress, hasAnyEvidence)

  // A visit is recorded on each of those attempts when the explainer is opened; one answered since has none yet.
  // Unlocking the gate is not a visit.
  const visits = recalls.map((attempt) => {
    const viewed = isRecord(attempt.explainer) && typeof attempt.explainer.viewedAt === 'string' ? new Date(attempt.explainer.viewedAt) : null
    return viewed && !Number.isNaN(viewed.getTime()) ? viewed : null
  })
  const explainerVisitedAt = visits.length > 0 && visits.every((visit) => visit !== null) ? visits.reduce<Date | null>((best, visit) => (!best || (visit && visit > best) ? visit : best), null) : null

  return {
    concepts,
    // Opening a topic makes its concepts, warm-up and notes; one with none of them has not been opened yet.
    prepared: conceptCount > 0 || warmupBank > 0 || writtenContent > 0,
    practiceDone: practice.done,
    practiceWritten: practice.written,
    warmupReady: warmupBank > 0,
    warmupAt: progress?.warmupAt ?? null,
    readAt,
    recallAt,
    recallGaps: latestRecallGaps(recalls.map((attempt) => attempt.result)),
    explainerVisitedAt,
    testedOutAt: progress?.testedOutAt ?? null,
    triage: progress?.triage === 'quick' ? 'quick' : null,
    gapExplainerReadyFor: [...new Set(recalls.flatMap((attempt) => writtenGapConcepts(attempt.explainer)))],
    nextReviewAt: nextReview?.dueAt ?? null,
    lastTeachBackAt: latest([teachBackEvent?.createdAt, teachBackAttempt?.createdAt]),
    lastHardQuizAt: hardQuiz.lastAt,
    hardSetOnHand: hardQuiz.onHand,
    lastExamAt: examEvent?.createdAt ?? null,
    hasAnyEvidence,
  }
}
