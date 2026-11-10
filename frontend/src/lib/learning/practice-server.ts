import { logServerError } from '@/lib/ops/log'
import { prisma } from '@/lib/db/prisma'
import { parsePracticeProblems } from '@/features/topic/content'
import {
  cleanRungs,
  cleanStepList,
  cleanSteps,
  problemFinished,
  problemScore,
  unionSteps,
  type ProblemProgress,
} from '@/features/topic/practice-keys'
import { recordEvidence } from './evidence'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule, type Db } from './mastery'
import type { ItemAnswerInput } from './evidence-types'
import {
  AUTHORED_HINT_RUNG,
  WORKED_RUNG,
  buildPracticeEvidence,
  practiceScopeKey,
  practiceStepEvidence as stepRecord,
  validatePracticeProgress,
  type PracticeState,
} from './practice-evidence'
import { gateHelp } from '@/lib/tutor/state'
import { studentTimeZone } from './student-time-zone'
import { localDateParts } from './study-plan-time'

/** A finished practice problem is "right" for scheduling the next review at this score or better. */
export const PRACTICE_PASS_SCORE = 0.5

export type PracticeSaveInput = {
  problemIndex: number
  problemTitle: string
  solvedSteps: number[]
  revealedSteps: number[]
  hintedSteps: number[]
  /**
   * Checked steps, first-try successes and the highest rung per step. Absent from a browser that
   * predates rungs: the problem is then stored as before and writes no evidence.
   */
  attemptedSteps?: number[]
  firstTrySteps?: number[]
  maxRungs?: Record<string, number>
  missRungs?: Record<string, number>
  trippedUp?: string
  /** The student's zone, for the local day in the evidence session key. */
  timeZone?: string
  /** Local progress uploaded for the first time: joined with what the server has, and no signal is recorded. */
  migrated?: boolean
}

export type PracticeSaveResult =
  /** The state cannot follow the stored one (validatePracticeProgress): nothing was stored. */
  | { status: 'invalid'; reason: string }
  /** Connect or deeper help, or a shown answer, with no attempt on the step (spec 18.4): nothing was stored; the route answers 409 ATTEMPT_FIRST. */
  | { status: 'attempt_first' }
  | { status: 'saved'; completed: boolean; completedNow: boolean; score: number | null }
  /** There is no such problem now (the practice was rewritten or has no content): nothing was stored. */
  | { status: 'stale' }

/** The practice problems of a topic as the page shows them, with the content row they belong to. */
export async function currentPractice(topicId: string) {
  const row = await prisma.topicContent.findUnique({
    where: { topicId_contentType: { topicId, contentType: 'interactive_examples' } },
    select: { id: true, contentData: true, updatedAt: true },
  })
  if (!row) return null
  const parsed = parsePracticeProblems(row.contentData, row.updatedAt.toISOString())
  return parsed ? { contentId: row.id, problems: parsed.items } : null
}

/**
 * Stores the steps solved, shown and hinted of one practice problem. The row is the student's
 * state of that problem (unique on user, content and problem); sending a smaller state is how
 * "Start over" works. When the last step is closed the problem is finished: that moment, once per
 * run through the problem, records a practice learning signal (score = steps solved without a hint
 * over all steps) and updates mastery and the review schedule like a quiz does.
 *
 * One save of a problem runs at a time (an advisory lock), so two saves cannot both read the same row and
 * write over each other. The evidence of a finished step is read from the server's own record of it
 * (the tutor state: the checks it graded, the help it gave), never from the browser's word, and is written in
 * the same transaction as the row; a step whose evidence could not be written stays unmarked and the next save
 * writes it.
 */
export async function savePracticeProgress(
  userId: string,
  topic: { id: string; projectId: string },
  input: PracticeSaveInput
): Promise<PracticeSaveResult> {
  const practice = await currentPractice(topic.id)
  const problem = practice?.problems[input.problemIndex]
  if (!practice || !problem || problem.title !== input.problemTitle) return { status: 'stale' }
  return prisma.$transaction((tx) => saveLocked(tx, userId, topic, practice.contentId, problem, input), { maxWait: 15_000, timeout: 30_000 })
}

type PracticeProblemContent = NonNullable<Awaited<ReturnType<typeof currentPractice>>>['problems'][number]

async function saveLocked(
  tx: Db,
  userId: string,
  topic: { id: string; projectId: string },
  contentId: string,
  problem: PracticeProblemContent,
  input: PracticeSaveInput
): Promise<PracticeSaveResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`practice:${userId}:${contentId}:${input.problemIndex}`}, 0))`
  const stepsTotal = problem.steps.length
  const where = { userId_contentId_problemIndex: { userId, contentId, problemIndex: input.problemIndex } }
  const existing = await tx.practiceProgress.findUnique({ where })
  // A row of a rewritten problem (another title) is not what this save continues.
  const sameRow = existing && existing.problemTitle === input.problemTitle ? existing : null
  const before = withHintFloor(stateOfRow(sameRow, stepsTotal), sameRow?.hintedSteps ?? [])

  let steps = cleanSteps(input, stepsTotal)
  if (input.migrated && sameRow) {
    steps = cleanSteps(unionSteps(steps, sameRow), stepsTotal)
  }

  // From a browser that predates rungs the extra fields are absent: keep what is stored, record no evidence.
  const legacy = input.attemptedSteps === undefined
  const noStepsDone = steps.solvedSteps.length === 0 && steps.revealedSteps.length === 0 && steps.hintedSteps.length === 0
  let reset = noStepsDone
  let next: PracticeState
  if (legacy) {
    next = reset ? emptyState() : { ...before, solvedSteps: steps.solvedSteps, revealedSteps: steps.revealedSteps }
  } else {
    next = {
      solvedSteps: steps.solvedSteps,
      revealedSteps: steps.revealedSteps,
      attemptedSteps: cleanStepList(input.attemptedSteps ?? [], stepsTotal),
      firstTrySteps: cleanStepList(input.firstTrySteps ?? [], stepsTotal),
      maxRungs: numberKeys(cleanRungs(input.maxRungs, stepsTotal)),
      missRungs: numberKeys(cleanRungs(input.missRungs, stepsTotal)),
    }
    next = withHintFloor(next, steps.hintedSteps)
    // "Start over" sends nothing at all. A step checked wrong and not yet solved sends its attempt: that is progress, and the
    // server's record of the checks it was built from (the tutor state) must survive it.
    reset = noStepsDone && next.attemptedSteps.length === 0 && next.firstTrySteps.length === 0 && Object.keys(next.maxRungs).length === 0 && Object.keys(next.missRungs).length === 0
    if (input.migrated && sameRow) next = unionState(before, next)
    // The hint gate (spec 18.4): Connect and deeper, and Show answer, need one attempt on the step.
    if (helpWithoutAttempt(before, next)) return { status: 'attempt_first' }
    // A first upload of local progress is held to the same rules as any other save.
    const check = validatePracticeProgress(sameRow ? before : null, next)
    if (!check.ok) return { status: 'invalid', reason: check.reason }
  }
  if (legacy) next = withHintFloor(next, steps.hintedSteps)

  const progress: ProblemProgress = { problemIndex: input.problemIndex, problemTitle: input.problemTitle, ...steps }
  const finished = problemFinished(progress, stepsTotal)
  const wasFinished = !!existing?.completedAt && existing.problemTitle === input.problemTitle
  const completedAt = finished ? (wasFinished ? existing.completedAt : new Date()) : null
  const trippedUp = legacy ? (reset ? null : (sameRow?.trippedUp ?? null)) : input.trippedUp?.trim().slice(0, 300) || null
  const finishedSteps = [...new Set([...steps.solvedSteps, ...steps.revealedSteps])]
  // "Start over" begins a new run: the ladder and the evidence start again with it.
  const written = reset ? [] : (sameRow?.evidenceSteps ?? [])
  const data = {
    topicId: topic.id,
    problemTitle: input.problemTitle,
    stepsSolved: steps.solvedSteps.length,
    stepsTotal,
    hintsUsed: steps.hintedSteps.length,
    solvedSteps: steps.solvedSteps,
    revealedSteps: steps.revealedSteps,
    hintedSteps: steps.hintedSteps,
    attemptedSteps: next.attemptedSteps,
    firstTrySteps: next.firstTrySteps,
    maxRungs: next.maxRungs,
    missRungs: next.missRungs,
    trippedUp,
    completedAt,
  }
  const writeRow = (db: Db, evidenceSteps: number[]) =>
    db.practiceProgress.upsert({
      where,
      create: { userId, contentId, problemIndex: input.problemIndex, ...data, evidenceSteps },
      update: { ...data, evidenceSteps },
    })

  if (reset) await tx.tutorState.deleteMany({ where: { userId, scope: 'practice', scopeKey: { startsWith: `${contentId}:${input.problemIndex}:` } } })

  // Progress uploaded from the browser for the first time is not scored, nor are its steps written later.
  // Otherwise the steps that finished, and those checked and already decided (an I don't know, help above locate, a
  // third check: spec 18.4), whose evidence is not written yet are read from the server's record.
  const pending = !legacy && !input.migrated ? [...new Set([...finishedSteps, ...next.attemptedSteps])].filter((step) => !written.includes(step)) : []
  const evidence = pending.length > 0 ? await practiceStepEvidence(tx, { userId, topic, contentId, problem, problemIndex: input.problemIndex, pending, steps, timeZone: input.timeZone ?? 'UTC' }) : null
  const settled = input.migrated ? finishedSteps : [...new Set([...written, ...(evidence?.settled ?? [])])]
  if (evidence && evidence.inputs.length > 0) {
    try {
      await recordEvidence(evidence.inputs, { timeZone: input.timeZone ?? 'UTC', userId, inTransaction: async (etx) => void (await writeRow(etx, settled)) })
    } catch (error) {
      // The progress is the student's: it is kept, and the steps stay unmarked so the next save writes their evidence.
      logServerError('Recording practice evidence failed', error)
      await writeRow(tx, input.migrated ? finishedSteps : written)
    }
  } else {
    await writeRow(tx, settled)
  }

  const completedNow = finished && !wasFinished
  const score = finished ? problemScore(progress, stepsTotal) : null
  // A save without rung fields (an older browser) is not validated: it is stored, but it earns no signal or review.
  if (completedNow && !input.migrated && !legacy && score !== null) {
    await recordLearningSignal({
      userId,
      projectId: topic.projectId,
      topicId: topic.id,
      source: 'practice',
      score,
      metadata: { contentId, problemIndex: input.problemIndex, problemTitle: input.problemTitle },
      db: tx,
    })
    const mastery = await computeTopicMastery(userId, topic.projectId, topic.id, tx)
    // A converted topic's schedule is its concepts' (written with the evidence above); this is for topics without them.
    await upsertReviewSchedule({
      userId,
      projectId: topic.projectId,
      topicId: topic.id,
      mastery: mastery.mastery,
      wasCorrect: score >= PRACTICE_PASS_SCORE,
      db: tx,
    })
  }
  return { status: 'saved', completed: finished, completedNow, score }
}

/** Whether this state holds help the gate holds back (Connect or deeper, a shown answer) on a step with no attempt. */
function helpWithoutAttempt(before: PracticeState, next: PracticeState): boolean {
  const attempted = new Set(next.attemptedSteps)
  const refused = (step: number, event: Parameters<typeof gateHelp>[1]) => !gateHelp({ checks: attempted.has(step) ? 1 : 0 }, event).ok
  for (const [step, rung] of Object.entries(next.maxRungs)) {
    if (rung >= GATED_RUNG && refused(Number(step), { type: 'hint_opened', index: 1 })) return true
  }
  return next.revealedSteps.some((step) => !before.revealedSteps.includes(step) && !before.solvedSteps.includes(step) && refused(step, { type: 'reveal' }))
}

/** The first rung that needs an attempt on the step (Connect); locate (rung 1) is open from the start. */
const GATED_RUNG = 3

const emptyState = (): PracticeState => ({ solvedSteps: [], revealedSteps: [], attemptedSteps: [], firstTrySteps: [], maxRungs: {}, missRungs: {} })

const numberKeys = (rungs: Record<string, number>): Record<number, number> =>
  Object.fromEntries(Object.entries(rungs).map(([step, rung]) => [Number(step), rung]))

/** A step with a hint opened has used at least the locate rung, whatever rung was sent (or none, from an older row). */
function withHintFloor(state: PracticeState, hinted: number[]): PracticeState {
  const maxRungs = { ...state.maxRungs }
  for (const step of hinted) maxRungs[step] = Math.max(maxRungs[step] ?? 0, 1)
  return { ...state, maxRungs }
}

/** A stored row as a practice state; a row from before rungs has empty extras. */
export function stateOfRow(
  row: { solvedSteps: number[]; revealedSteps: number[]; attemptedSteps: number[]; firstTrySteps: number[]; maxRungs: unknown; missRungs: unknown } | null,
  stepsTotal: number
): PracticeState {
  if (!row) return emptyState()
  const stored = (value: unknown) => cleanRungs(value && typeof value === 'object' ? (value as Record<string, number>) : {}, stepsTotal)
  return {
    solvedSteps: row.solvedSteps,
    revealedSteps: row.revealedSteps,
    attemptedSteps: row.attemptedSteps,
    firstTrySteps: row.firstTrySteps,
    maxRungs: numberKeys(stored(row.maxRungs)),
    missRungs: numberKeys(stored(row.missRungs)),
  }
}

/** Two states of one problem joined (a first upload of local progress): each part keeps the larger. */
function unionState(a: PracticeState, b: PracticeState): PracticeState {
  const join = (x: number[], y: number[]) => [...new Set([...x, ...y])].sort((m, n) => m - n)
  const maxRungs: Record<number, number> = { ...a.maxRungs }
  for (const [step, rung] of Object.entries(b.maxRungs)) maxRungs[Number(step)] = Math.max(maxRungs[Number(step)] ?? 0, rung)
  const solvedSteps = join(a.solvedSteps, b.solvedSteps)
  return {
    solvedSteps,
    revealedSteps: join(a.revealedSteps, b.revealedSteps).filter((step) => !solvedSteps.includes(step)),
    attemptedSteps: join(a.attemptedSteps, b.attemptedSteps),
    firstTrySteps: join(a.firstTrySteps, b.firstTrySteps),
    maxRungs,
    missRungs: { ...b.missRungs, ...a.missRungs },
  }
}

/**
 * The evidence of the steps that finished and are not written yet. What the student did on a step comes from the
 * server's tutor state for it: the checks it graded (a step counts as solved only when the server saw the right
 * answer), the help it gave, and the help level at the first wrong check. A finished step the server has no record
 * of yet is left for a later save. `settled` lists the steps that need no more attention: those whose evidence is
 * in `inputs` (or that have no concepts to write to).
 */
async function practiceStepEvidence(
  tx: Db,
  input: {
    userId: string
    topic: { id: string; projectId: string }
    contentId: string
    problem: PracticeProblemContent
    problemIndex: number
    pending: number[]
    steps: { solvedSteps: number[]; revealedSteps: number[] }
    timeZone: string
    /** Steps written as a failed first try even though nothing decided them yet: an open miss left behind (settleOpenMisses). */
    abandoned?: ReadonlySet<number>
    /** When the evidence happened and which local day it belongs to; now by default. */
    at?: Date
  }
): Promise<{ inputs: ItemAnswerInput[]; settled: number[] }> {
  const rows = await tx.tutorState.findMany({
    where: {
      userId: input.userId,
      scope: 'practice',
      scopeKey: { in: input.pending.map((step) => practiceScopeKey(input.contentId, input.problemIndex, step)) },
    },
  })
  const byStep = new Map(rows.map((row) => [Number(row.scopeKey.split(':').pop()), row]))
  const solved = new Set(input.steps.solvedSteps)
  const state = emptyState()
  // A step with no concepts has no evidence to write, whatever the tutor state says.
  const ready: number[] = input.pending.filter((step) => (input.problem.steps[step]?.conceptIds ?? []).length === 0)
  for (const step of input.pending) {
    if (ready.includes(step)) continue
    const row = byStep.get(step)
    if (!row) continue
    const help = helpOf(row)
    // A shown answer needs an attempt on the step (spec 18.4): a checked answer or an IDK, both counted in `checks`.
    const verified = solved.has(step) ? row.checkedCorrect : row.checks >= 1
    if (!verified) continue
    const finished = solved.has(step) || input.steps.revealedSteps.includes(step)
    // A step still open is written only once its record is decided (a level-1 record is final the moment it is decided), or
    // when it was left behind. A right answer the browser has not reported as solved yet waits for that save.
    if (!finished && (row.checkedCorrect || !(input.abandoned?.has(step) || isDecided(row, input.problem.steps[step], help)))) continue
    ready.push(step)
    if (solved.has(step)) state.solvedSteps.push(step)
    else state.revealedSteps.push(step)
    if (row.checks >= 1) state.attemptedSteps.push(step)
    if (row.checkedCorrect && row.wrongChecks === 0) state.firstTrySteps.push(step)
    state.maxRungs[step] = help.rung
    if (row.wrongChecks >= 1) state.missRungs[step] = row.firstMissRung ?? help.rung
  }
  if (ready.length === 0) return { inputs: [], settled: [] }
  const wanted = [...new Set(ready.flatMap((step) => input.problem.steps[step]?.conceptIds ?? []))]
  const known = new Set(
    wanted.length === 0
      ? []
      : (
          await tx.concept.findMany({
            where: { id: { in: wanted }, projectId: input.topic.projectId, status: 'active' },
            select: { id: true },
          })
        ).map((concept) => concept.id)
  )
  const inputs = buildPracticeEvidence({
    userId: input.userId,
    projectId: input.topic.projectId,
    topicId: input.topic.id,
    contentId: input.contentId,
    problemIndex: input.problemIndex,
    conceptIdsOf: (step) => (input.problem.steps[step]?.conceptIds ?? []).filter((id) => known.has(id)),
    newlyFinished: ready,
    next: state,
    sessionKey: practiceSessionKey(input.contentId, input.timeZone, input.at),
    at: input.at,
    // What the server saw of each step, for the first-try record (spec 18.4).
    detail: (step) => {
      const row = byStep.get(step)
      if (!row) return {}
      const options = input.problem.steps[step]?.options ?? []
      return {
        checks: row.checks,
        solvedOnCheck: row.checkedCorrect ? row.checks : null,
        twoOption: input.problem.steps[step]?.answerType === 'multiple_choice' && options.length === 2,
        dontKnow: row.dontKnowAt !== null,
        workedDelivered: helpOf(row).rung >= WORKED_RUNG,
      }
    },
  })
  return { inputs, settled: ready }
}

/**
 * Whether an unfinished step's first-try record can no longer change (spec 18.4): an I don't know, help above locate, a
 * delivered worked example, a second wrong check, a wrong check on a two-option choice. One wrong check with at most the
 * locate hint is still open, because a success on the second check scores 0.6.
 */
function isDecided(
  row: { checks: number; dontKnowAt: Date | null; helpRung: number; hintsOpened: number; maxRung: number },
  step: PracticeProblemContent['steps'][number] | undefined,
  help: { rung: number }
): boolean {
  const options = step?.options ?? []
  return (
    stepRecord({
      firstTryCorrect: false,
      attempted: true,
      maxRung: help.rung as 0 | 1 | 2 | 3 | 4 | 5,
      revealed: false,
      solved: false,
      checks: row.checks,
      solvedOnCheck: null,
      twoOption: step?.answerType === 'multiple_choice' && options.length === 2,
      dontKnow: row.dontKnowAt !== null,
      workedDelivered: help.rung >= WORKED_RUNG,
    }) !== null
  )
}

/** The help a tutor-state row records: the highest rung given, and the rung of the last authored hint opened. */
function helpOf(row: { helpRung: number; hintsOpened: number; maxRung: number }): { rung: number; hintRung: number } {
  const hintRung = row.hintsOpened > 0 ? AUTHORED_HINT_RUNG[Math.min(row.hintsOpened, AUTHORED_HINT_RUNG.length) - 1] : 0
  // Rung 5 is reached only by the student's worked-example button; below it `maxRung` is the ladder's ceiling, not help given.
  return { rung: Math.max(row.helpRung, hintRung, row.maxRung >= WORKED_RUNG ? WORKED_RUNG : 0), hintRung }
}

/**
 * Writes level 1, score 0 for the steps left with one wrong check, unfinished, whose last activity was on an earlier local
 * day (spec 18.4): leaving after a miss must not be cheaper than asking for help. The step's first check is the last thing
 * recorded on a step that has not moved since, so the row's `updatedAt` is its local day; the evidence belongs to that day's
 * session. A step whose record was decided earlier is written here too, should a save have missed it. Safe to repeat and to
 * run twice at once: the problem's row says which steps are written. Returns how many steps it wrote.
 */
export async function settleOpenMisses(userId: string, topicId: string, timeZone: string, now: Date = new Date()): Promise<{ settled: number }> {
  const practice = await currentPractice(topicId)
  if (!practice) return { settled: 0 }
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true, projectId: true } })
  if (!topic) return { settled: 0 }
  const rows = await prisma.tutorState.findMany({
    where: { userId, scope: 'practice', scopeKey: { startsWith: `${practice.contentId}:` }, checks: { gte: 1 }, checkedCorrect: false },
  })
  const today = localDayKey(now, timeZone)
  let settled = 0
  for (const row of rows) {
    const [, problemPart, stepPart] = row.scopeKey.split(':')
    const problemIndex = Number(problemPart)
    const step = Number(stepPart)
    const problem = practice.problems[problemIndex]
    if (!problem?.steps[step]) continue
    const old = localDayKey(row.updatedAt, timeZone) < today
    try {
      settled += await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`practice:${userId}:${practice.contentId}:${problemIndex}`}, 0))`
          const progress = await tx.practiceProgress.findUnique({ where: { userId_contentId_problemIndex: { userId, contentId: practice.contentId, problemIndex } } })
          // A step the student finished is the save's to write; a problem the browser has not saved yet has nowhere to say what is written.
          if (!progress || progress.problemTitle !== problem.title || progress.evidenceSteps.includes(step)) return 0
          if (progress.solvedSteps.includes(step) || progress.revealedSteps.includes(step)) return 0
          const evidence = await practiceStepEvidence(tx, {
            userId,
            topic,
            contentId: practice.contentId,
            problem,
            problemIndex,
            pending: [step],
            steps: { solvedSteps: progress.solvedSteps, revealedSteps: progress.revealedSteps },
            timeZone,
            abandoned: old ? new Set([step]) : new Set(),
            at: row.updatedAt,
          })
          if (evidence.settled.length === 0) return 0
          const write = (db: Db) => db.practiceProgress.update({ where: { id: progress.id }, data: { evidenceSteps: [...new Set([...progress.evidenceSteps, ...evidence.settled])] } })
          if (evidence.inputs.length === 0) await write(tx)
          else await recordEvidence(evidence.inputs, { timeZone, userId, inTransaction: async (etx) => void (await write(etx)) })
          return evidence.inputs.length
        },
        { maxWait: 15_000, timeout: 30_000 }
      )
    } catch (error) {
      // The next visit tries again.
      logServerError('Settling an open practice miss failed', error)
    }
  }
  return { settled }
}

/** The student's stored progress on the topic's current practice problems (rows of an older practice are left out). Settles the misses left open on an earlier day first. */
export async function loadPracticeProgress(userId: string, topicId: string, timeZone?: string): Promise<ProblemProgress[]> {
  const practice = await currentPractice(topicId)
  if (!practice) return []
  await settleOpenMisses(userId, topicId, timeZone ?? (await studentTimeZone())).catch((error) => logServerError('Settling open practice misses failed', error))
  const rows = await prisma.practiceProgress.findMany({
    where: { userId, topicId, contentId: practice.contentId },
    orderBy: { problemIndex: 'asc' },
  })
  return rows
    .filter((row) => practice.problems[row.problemIndex]?.title === row.problemTitle)
    .map((row) => practiceRowProgress(row, practice.problems[row.problemIndex].steps.length))
}

/** A stored row as the progress the browser holds (rows from before rungs have empty attempts and no rungs). */
export function practiceRowProgress(
  row: {
    problemIndex: number
    problemTitle: string
    solvedSteps: number[]
    revealedSteps: number[]
    hintedSteps: number[]
    attemptedSteps: number[]
    firstTrySteps: number[]
    maxRungs: unknown
    missRungs: unknown
    trippedUp: string | null
  },
  stepsTotal: number
): ProblemProgress {
  return {
    problemIndex: row.problemIndex,
    problemTitle: row.problemTitle,
    solvedSteps: row.solvedSteps,
    revealedSteps: row.revealedSteps,
    hintedSteps: row.hintedSteps,
    attemptedSteps: row.attemptedSteps,
    firstTrySteps: row.firstTrySteps,
    maxRungs: cleanRungs(row.maxRungs as Record<string, number> | null, stepsTotal),
    missRungs: cleanRungs(row.missRungs as Record<string, number> | null, stepsTotal),
    ...(row.trippedUp ? { trippedUp: row.trippedUp } : {}),
  }
}

/** The evidence session of a practice topic page on the student's local day (spec §5.6). */
export function practiceSessionKey(contentId: string, timeZone: string, now: Date = new Date()): string {
  return `practice:${contentId}:${localDayKey(now, timeZone)}`
}

/** The student's local calendar day, as yyyy-mm-dd. */
function localDayKey(at: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(at, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
