import { Prisma } from '@prisma/client'
import { ownedTopic } from '@/server/owned'
import { prisma } from '@/lib/db/prisma'
import { parsePracticeProblems } from '@/features/topic/content'
import type { GradedQuestion } from '@/lib/ai-service/grading'
import type { ItemAnswerInput } from './evidence-types'
import { rebuildConcepts, recordEvidence } from './evidence'
import { buildExamEvidence } from './exam-evidence'
import { itemKey } from './item-key'
import { buildPracticeEvidence } from './practice-evidence'
import { stateOfRow } from './practice-server'
import { normalizeAnswers } from './quiz-answers'
import { buildQuizEvidence } from './quiz-evidence'
import { loadAllQuizQuestionSets } from './quiz-sets'


/**
 * Turns a project's history into learner-model evidence (spec §12). Idempotent and safe to re-run: each
 * source row writes events carrying `metadata.backfillOf` (the row's id), and a row that has events
 * already, from an earlier run or recorded live, is skipped (and checked again inside the write's lock,
 * so a concurrent live write cannot make an answer count twice). A chunk of whole source rows is written
 * in one transaction, so a run that stops half way leaves whole rows only and the next run finishes the rest.
 *
 * Readiness is per topic. A topic with active concepts is converted; a topic without (extraction failed
 * or has not run) is never ready and keeps the legacy mastery blend. A source row that touches several
 * topics (a mock exam) waits until all of them are ready and is converted by the run that starts when the
 * last one becomes ready, so no history is skipped. Each converted topic gets `Topic.evidenceBackfilledAt` (the switch to concept mastery, lib/learning/mastery.ts);
 * the project marker means every confirmed topic is converted.
 *
 * Rows that were converted already are left out in SQL (their ids are known from the events), so a run reads
 * only what is still to do. A run can be scoped to one topic: it reads and converts only the rows that touch
 * that topic, and marks that topic alone.
 *
 * How it is run: the course overview calls `backfillIfDue` (below), a topic page calls `convertTopicIfDue`;
 * `npm run backfill-evidence` (scripts/backfill-evidence.ts) runs it for every project, or for one with `-- <projectId>`.
 */

type RawQuestion = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Most answers written in one transaction; whole source rows only. */
const CHUNK_INPUTS = 300

type Known = {
  conceptIds: Set<string>
  /** Active concept id -> its topic. */
  conceptTopic: Map<string, string>
  /** Topics with at least one active concept: the ones that can be converted. */
  ready: Set<string>
  topicIds: Set<string>
  /** `backfillOf` values already written. */
  backfilled: Set<string>
  /** Session keys of quiz and exam evidence (live or backfilled). */
  sessionKeys: Set<string>
  /** Item keys of practice and voice evidence (live or backfilled). */
  itemKeys: Set<string>
}

async function loadKnown(userId: string, projectId: string): Promise<Known> {
  const [concepts, topics, backfilled, sessionKeys, itemKeys] = await Promise.all([
    prisma.concept.findMany({ where: { projectId, status: 'active' }, select: { id: true, topicId: true } }),
    prisma.topic.findMany({ where: { projectId }, select: { id: true } }),
    prisma.$queryRaw<{ k: string }[]>`
      SELECT DISTINCT metadata->>'backfillOf' AS k FROM evidence_events
      WHERE user_id = ${userId} AND project_id = ${projectId} AND metadata ? 'backfillOf'`,
    prisma.$queryRaw<{ k: string }[]>`
      SELECT DISTINCT session_key AS k FROM evidence_events
      WHERE user_id = ${userId} AND project_id = ${projectId} AND source IN ('quiz', 'exam')`,
    prisma.$queryRaw<{ k: string }[]>`
      SELECT DISTINCT item_key AS k FROM evidence_events
      WHERE user_id = ${userId} AND project_id = ${projectId} AND source IN ('practice', 'voice')`,
  ])
  return {
    conceptIds: new Set(concepts.map((c) => c.id)),
    conceptTopic: new Map(concepts.map((c) => [c.id, c.topicId])),
    ready: new Set(concepts.map((c) => c.topicId)),
    topicIds: new Set(topics.map((t) => t.id)),
    backfilled: new Set(backfilled.map((r) => r.k)),
    sessionKeys: new Set(sessionKeys.map((r) => r.k)),
    itemKeys: new Set(itemKeys.map((r) => r.k)),
  }
}

/** Whether a row touching these topics can be converted now. A row that cannot waits, and is looked at again the next time a topic becomes ready. */
function readyFor(known: Known, topicIds: Iterable<string | null | undefined>): boolean {
  const touched = [...new Set([...topicIds].filter((id): id is string => !!id && known.topicIds.has(id)))]
  return touched.every((id) => known.ready.has(id))
}

const withBackfillOf = (inputs: ItemAnswerInput[], id: string): ItemAnswerInput[] =>
  inputs.map((input) => ({ ...input, metadata: { ...input.metadata, backfillOf: id } }))

/** One quiz attempt's stored results as the graded questions the evidence builder reads. */
function gradedFromStored(results: unknown, questions: RawQuestion[]): GradedQuestion[] {
  if (!isRecord(results)) return []
  const graded: GradedQuestion[] = []
  for (const [key, value] of Object.entries(results)) {
    const index = Number(key)
    const question = questions[index]
    if (!Number.isInteger(index) || !question) continue
    // Results come in two shapes: the object form and older plain booleans.
    const stored = isRecord(value) ? value : { isCorrect: value === true }
    const possible = typeof stored.pointsPossible === 'number' ? stored.pointsPossible : 1
    const earned = typeof stored.pointsEarned === 'number' ? stored.pointsEarned : stored.isCorrect === true ? possible : 0
    graded.push({
      question_index: index,
      question_type: typeof question.question_type === 'string' ? question.question_type : 'multiple_choice',
      points_possible: possible,
      points_earned: earned,
      is_correct: stored.isCorrect === true,
      feedback: '',
      needs_review: false,
    })
  }
  return graded
}

/** Most ids read in one query. */
const ID_BATCH = 500

/**
 * The ids of a user's rows in `table` that have no evidence yet, decided in SQL (NOT EXISTS against the events, by the row id
 * in `backfillOf`, and for quizzes and exams by the `quiz:<id>` / `exam:<id>` session key of a live write), so a run never
 * reads rows it would skip and no list of converted ids is sent back to the database.
 */
async function unconvertedIds(
  table: 'quiz_attempts' | 'exam_submissions' | 'practice_progress' | 'voice_drill_attempts',
  userId: string,
  projectId: string,
  sessionPrefix?: 'quiz' | 'exam'
): Promise<string[]> {
  const bySession = sessionPrefix ? Prisma.sql` OR e.session_key = ${`${sessionPrefix}:`} || r.id` : Prisma.empty
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM ${Prisma.raw(table)} r
    WHERE r.user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM evidence_events e
        WHERE e.user_id = ${userId} AND e.project_id = ${projectId} AND (e.metadata->>'backfillOf' = r.id${bySession})
      )`
  return rows.map((row) => row.id)
}

/** Rows by id in batches, so a long list never becomes one huge bind list. */
async function inBatches<T>(ids: string[], read: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += ID_BATCH) out.push(...(await read(ids.slice(i, i + ID_BATCH))))
  return out
}

async function quizRows(userId: string, projectId: string, known: Known, scope?: string): Promise<{ id: string; inputs: ItemAnswerInput[] }[]> {
  const attempts = (
    await inBatches(await unconvertedIds('quiz_attempts', userId, projectId, 'quiz'), (ids) =>
      prisma.quizAttempt.findMany({
        where: { id: { in: ids }, userId, topic: { projectId }, ...(scope ? { topicId: scope } : {}) },
        select: { id: true, topicId: true, quizSetId: true, answers: true, results: true, takenAt: true },
      })
    )
  ).sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())
  const setsByTopic = new Map<string, Map<string | null, RawQuestion[]>>()
  const rows: { id: string; inputs: ItemAnswerInput[] }[] = []
  for (const attempt of attempts) {
    if (known.backfilled.has(attempt.id) || known.sessionKeys.has(`quiz:${attempt.id}`)) continue
    if (!readyFor(known, [attempt.topicId])) continue
    if (!setsByTopic.has(attempt.topicId)) {
      const topic = await ownedTopic(userId, attempt.topicId)
      setsByTopic.set(attempt.topicId, topic ? await loadAllQuizQuestionSets(topic) : new Map())
    }
    const questions = setsByTopic.get(attempt.topicId)?.get(attempt.quizSetId)
    if (!questions) continue
    const inputs = buildQuizEvidence({
      userId,
      projectId,
      topicId: attempt.topicId,
      quizSetId: attempt.quizSetId,
      attemptId: attempt.id,
      questions,
      answers: normalizeAnswers(attempt.answers),
      graded: gradedFromStored(attempt.results, questions),
      knownConceptIds: known.conceptIds,
      at: attempt.takenAt,
    })
    if (inputs.length > 0) rows.push({ id: attempt.id, inputs: withBackfillOf(inputs, attempt.id) })
  }
  return rows
}

async function examRows(userId: string, projectId: string, known: Known, scope?: string): Promise<{ id: string; inputs: ItemAnswerInput[] }[]> {
  const submissions = (
    await inBatches(await unconvertedIds('exam_submissions', userId, projectId, 'exam'), (ids) =>
      prisma.examSubmission.findMany({
        where: { id: { in: ids }, userId, status: 'submitted', gradedAt: { not: null }, sampleExam: { projectId } },
        select: { id: true, answers: true, aiGrading: true, submittedAt: true, sampleExam: { select: { id: true, questions: true } } },
      })
    )
  ).sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0))
  const rows: { id: string; inputs: ItemAnswerInput[] }[] = []
  for (const submission of submissions) {
    if (known.backfilled.has(submission.id) || known.sessionKeys.has(`exam:${submission.id}`)) continue
    if (!Array.isArray(submission.sampleExam.questions)) continue
    // The topics of the questions that carry concepts: the exam waits until all of them are ready.
    const touched = (submission.sampleExam.questions as RawQuestion[]).flatMap((question) => {
      const ids = (Array.isArray(question.concept_ids) ? question.concept_ids : []).filter(
        (id): id is string => typeof id === 'string' && known.conceptIds.has(id)
      )
      if (ids.length === 0) return []
      return [typeof question.topic_id === 'string' ? question.topic_id : null, ...ids.map((id) => known.conceptTopic.get(id))]
    })
    if (scope && !touched.includes(scope)) continue
    if (!readyFor(known, touched)) continue
    const inputs = buildExamEvidence({
      userId,
      projectId,
      examId: submission.sampleExam.id,
      submissionId: submission.id,
      questions: submission.sampleExam.questions as RawQuestion[],
      answers: submission.answers,
      aiGrading: submission.aiGrading,
      knownConceptIds: known.conceptIds,
      knownTopicIds: known.topicIds,
      at: submission.submittedAt,
    })
    if (inputs.length > 0) rows.push({ id: submission.id, inputs: withBackfillOf(inputs, submission.id) })
  }
  return rows
}

/**
 * Practice: a solved step with no hint is level 0, a revealed step is level 1 with score 0, and a
 * hint of the old kind (one hint, no rung) is the connect hint, rung 3 (spec 12), which fails the first try: level 1. A row from before
 * first tries were stored scores its solved steps as later-try successes (0.6): it is not known
 * that they were right at once.
 */
async function practiceRows(userId: string, projectId: string, known: Known, scope?: string): Promise<{ id: string; inputs: ItemAnswerInput[] }[]> {
  const progress = (
    await inBatches(await unconvertedIds('practice_progress', userId, projectId), (ids) =>
      prisma.practiceProgress.findMany({ where: { id: { in: ids }, userId, topic: { projectId }, ...(scope ? { topicId: scope } : {}) } })
    )
  ).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
  const contentIds = [...new Set(progress.map((row) => row.contentId))]
  const contents = await prisma.topicContent.findMany({
    where: { id: { in: contentIds }, contentType: 'interactive_examples' },
    select: { id: true, contentData: true, updatedAt: true },
  })
  const problemsByContent = new Map(
    contents.map((content) => [content.id, parsePracticeProblems(content.contentData, content.updatedAt.toISOString())?.items ?? []])
  )
  const rows: { id: string; inputs: ItemAnswerInput[] }[] = []
  for (const row of progress) {
    if (known.backfilled.has(row.id)) continue
    const problem = problemsByContent.get(row.contentId)?.[row.problemIndex]
    // Progress on a problem that was rewritten since is not evidence about the new one.
    if (!problem || problem.title !== row.problemTitle) continue
    if (!readyFor(known, [row.topicId])) continue
    const state = stateOfRow(row, problem.steps.length)
    const finished = [...state.solvedSteps, ...state.revealedSteps]
    // A hinted step has used at least the first rung; with no stored rungs (an old row) the one hint was the connect hint, rung 3.
    for (const step of row.hintedSteps) {
      state.maxRungs[step] = Math.max(state.maxRungs[step] ?? 0, row.maxRungs === null ? 3 : 1)
    }
    // A row from before checks were stored: a solved step was checked.
    if (row.attemptedSteps.length === 0) state.attemptedSteps = [...state.solvedSteps]
    const newlyFinished = finished.filter(
      (step) => !known.itemKeys.has(itemKey({ kind: 'practice', contentId: row.contentId, problem: row.problemIndex, step }))
    )
    const inputs = buildPracticeEvidence({
      userId,
      projectId,
      topicId: row.topicId,
      contentId: row.contentId,
      problemIndex: row.problemIndex,
      conceptIdsOf: (step) => (problem.steps[step]?.conceptIds ?? []).filter((id) => known.conceptIds.has(id)),
      newlyFinished,
      next: state,
      sessionKey: `practice:${row.contentId}:backfill:${row.problemIndex}`,
      at: row.completedAt ?? row.updatedAt,
    })
    if (inputs.length > 0) rows.push({ id: row.id, inputs: withBackfillOf(inputs, row.id) })
  }
  return rows
}

/** Voice: a graded spoken answer is level 0 (whether a hint came first was not recorded before). */
async function voiceRows(userId: string, projectId: string, known: Known, scope?: string): Promise<{ id: string; inputs: ItemAnswerInput[] }[]> {
  const attempts = (
    await inBatches(await unconvertedIds('voice_drill_attempts', userId, projectId), (ids) =>
      prisma.voiceDrillAttempt.findMany({
        where: {
          id: { in: ids },
          userId,
          session: { projectId },
          ...(scope ? { OR: [{ topicId: scope }, { topicId: null, session: { topicId: scope } }] } : {}),
        },
        select: {
          id: true,
          sessionId: true,
          topicId: true,
          questionIndex: true,
          score: true,
          feedback: true,
          createdAt: true,
          session: { select: { questionSet: true, topicId: true } },
        },
      })
    )
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const rows: { id: string; inputs: ItemAnswerInput[] }[] = []
  for (const attempt of attempts) {
    const key = itemKey({ kind: 'voice', sessionId: attempt.sessionId, index: attempt.questionIndex })
    if (known.backfilled.has(attempt.id) || known.itemKeys.has(key)) continue
    // An ungraded answer is not evidence of anything.
    if (isRecord(attempt.feedback) && attempt.feedback.ungraded === true) continue
    const question = Array.isArray(attempt.session.questionSet) ? attempt.session.questionSet[attempt.questionIndex] : null
    const wanted = isRecord(question) && Array.isArray(question.concept_ids) ? question.concept_ids : []
    const conceptIds = wanted.filter((id): id is string => typeof id === 'string' && known.conceptIds.has(id))
    if (conceptIds.length === 0) continue
    const topicId = attempt.topicId ?? attempt.session.topicId
    if (!readyFor(known, [topicId, ...conceptIds.map((id) => known.conceptTopic.get(id))])) continue
    rows.push({
      id: attempt.id,
      inputs: withBackfillOf(
        [
          {
            userId,
            projectId,
            topicId: topicId && known.topicIds.has(topicId) ? topicId : null,
            itemKey: key,
            conceptIds,
            source: 'voice',
            score: Math.min(1, Math.max(0, attempt.score)),
            assistance: 0,
            gradedBy: 'model',
            sessionKey: `voice:${attempt.sessionId}`,
            metadata: { questionIndex: attempt.questionIndex },
            at: attempt.createdAt,
          },
        ],
        attempt.id
      ),
    })
  }
  return rows
}

const eventCount = (inputs: ItemAnswerInput[]) => inputs.reduce((sum, input) => sum + new Set(input.conceptIds).size, 0)

type RunResult = { events: number; converted: string[] }

async function run(userId: string, projectId: string, timeZone: string, scope?: string): Promise<RunResult> {
  const known = await loadKnown(userId, projectId)
  // Nothing to attach history to yet.
  if (known.ready.size === 0 || (scope && !known.ready.has(scope))) return { events: 0, converted: [] }
  let events = 0
  const rows = [
    ...(await quizRows(userId, projectId, known, scope)),
    ...(await examRows(userId, projectId, known, scope)),
    ...(await practiceRows(userId, projectId, known, scope)),
    ...(await voiceRows(userId, projectId, known, scope)),
  ]
  let chunk: ItemAnswerInput[] = []
  const flush = async () => {
    if (chunk.length === 0) return
    // skipIfPresent: a live writer may have recorded one of these since the keys were read.
    await recordEvidence(chunk, { timeZone, userId, skipIfPresent: true })
    events += eventCount(chunk)
    chunk = []
  }
  for (const row of rows) {
    chunk.push(...row.inputs)
    if (chunk.length >= CHUNK_INPUTS) await flush()
  }
  await flush()

  // Every ready topic (or the one topic of a scoped run) is converted: marked and replayed in one transaction, so a crash cannot leave a marked
  // topic whose schedule still holds the blend. A row that waits on a topic that is not ready (an exam across
  // topics) is not lost: it is looked at again when that topic becomes ready, because that topic is then ready
  // and unmarked, which is what makes the next run start. Until then this topic runs on what it has.
  const converted = (
    await prisma.topic.findMany({
      where: { projectId, id: { in: scope ? [scope] : [...known.ready] }, evidenceBackfilledAt: null },
      select: { id: true },
    })
  ).map((topic) => topic.id)
  if (converted.length > 0) {
    const conceptIds = [...known.conceptTopic].filter(([, topicId]) => converted.includes(topicId)).map(([id]) => id)
    await rebuildConcepts(userId, conceptIds, timeZone, async (tx) => {
      await tx.topic.updateMany({ where: { id: { in: converted }, evidenceBackfilledAt: null }, data: { evidenceBackfilledAt: new Date() } })
    })
  }
  const unconverted = await prisma.topic.count({ where: { projectId, userConfirmed: true, evidenceBackfilledAt: null } })
  const confirmed = await prisma.topic.count({ where: { projectId, userConfirmed: true } })
  if (confirmed > 0 && unconverted === 0) {
    await prisma.$executeRaw`UPDATE projects SET evidence_backfilled_at = (${new Date()} AT TIME ZONE 'UTC') WHERE id = ${projectId} AND user_id = ${userId}`
  }
  return { events, converted }
}

/**
 * Converts the student's quiz, exam, practice and voice history in a project into evidence and replays
 * the memory of every concept it touches. Returns how many events it wrote (0 on a re-run). Marks each
 * topic it converted, and the project when every confirmed topic is.
 */
export async function backfillEvidence(
  userId: string,
  projectId: string,
  opts: { timeZone?: string } = {}
): Promise<{ events: number }> {
  const { events } = await run(userId, projectId, opts.timeZone ?? 'UTC')
  return { events }
}

/** How long a run keeps others away; a run that died is picked up after this. */
export const BACKFILL_LEASE_MS = 10 * 60 * 1000

/**
 * The course overview's hook: convert the topics that are ready and not yet converted.
 * - 'waiting': nothing is ready to convert (no topic has concepts yet, or every ready topic is done).
 * - 'busy': another run holds the lease.
 * - 'ran': this call did the work.
 * - 'done': every confirmed topic is converted.
 * With `opts.topicId` the call is scoped to that topic (see `convertTopicIfDue`).
 * A short lease (Project.evidenceBackfillClaimedAt) keeps concurrent runs apart and also paces retries;
 * the "done" markers are set only by a run that finished its work, so a run that died leaves nothing
 * marked and is picked up when the lease expires. The lease is released only when nothing ready is left.
 */
export async function backfillIfDue(
  userId: string,
  projectId: string,
  opts: { timeZone?: string; now?: Date; topicId?: string } = {}
): Promise<'waiting' | 'busy' | 'ran' | 'done'> {
  const now = opts.now ?? new Date()
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
  if (!project) return 'done'
  const pending = await prisma.topic.count({
    where: { projectId, ...(opts.topicId ? { id: opts.topicId } : {}), evidenceBackfilledAt: null, concepts: { some: { status: 'active' } } },
  })
  if (pending === 0) {
    const unconverted = await prisma.topic.count({ where: { projectId, userConfirmed: true, evidenceBackfilledAt: null } })
    return unconverted === 0 ? 'done' : 'waiting'
  }

  // Raw SQL (timestamp columns hold UTC, hence AT TIME ZONE): these are bookkeeping, and an ORM update would move Project.updatedAt, which orders the
  // student's courses (Home's "Up next" takes the most recently touched one).
  const expired = new Date(now.getTime() - BACKFILL_LEASE_MS)
  const claimed = await prisma.$executeRaw`UPDATE projects SET evidence_backfill_claimed_at = (${now} AT TIME ZONE 'UTC')
    WHERE id = ${projectId} AND user_id = ${userId}
    AND (evidence_backfill_claimed_at IS NULL OR evidence_backfill_claimed_at < (${expired} AT TIME ZONE 'UTC'))`
  if (claimed === 0) return 'busy'

  if (opts.topicId) {
    try {
      await run(userId, projectId, opts.timeZone ?? 'UTC', opts.topicId)
    } finally {
      // A topic's own run is finished work (or failed alone), so it does not hold the lease against the overview's run.
      // Only this run's claim is cleared: if the lease expired and another run took it, that run keeps it.
      await prisma.$executeRaw`UPDATE projects SET evidence_backfill_claimed_at = NULL
        WHERE id = ${projectId} AND user_id = ${userId} AND evidence_backfill_claimed_at = (${now} AT TIME ZONE 'UTC')`
    }
    return 'ran'
  }
  await run(userId, projectId, opts.timeZone ?? 'UTC')
  const left = await prisma.topic.count({
    where: { projectId, evidenceBackfilledAt: null, concepts: { some: { status: 'active' } } },
  })
  if (left === 0) await prisma.$executeRaw`UPDATE projects SET evidence_backfill_claimed_at = NULL WHERE id = ${projectId} AND user_id = ${userId}`
  return 'ran'
}

/**
 * The topic page's hook: a topic whose concepts finished after the course overview was last opened is converted when
 * the topic itself is opened, before its path is worked out, so Recall is offered and the explainer is gated from the
 * first view. It is the same lease as the overview's (nothing converted twice), but the run reads and converts only the
 * rows that touch this topic and marks this topic; the other topics wait for the overview. A topic with no history costs
 * a few reads and one replay-free marking. Returns true when this call converted the topic; false for a converted topic,
 * one without concepts, or when another run holds the lease (that run converts it and the next load sees the result).
 */
export async function convertTopicIfDue(userId: string, projectId: string, topicId: string, opts: { timeZone?: string } = {}): Promise<boolean> {
  return (await backfillIfDue(userId, projectId, { ...opts, topicId })) === 'ran'
}
