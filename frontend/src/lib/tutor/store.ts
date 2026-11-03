/**
 * The TutorState row (spec §3.1, §6.2): where one tutoring conversation stands on the hint ladder.
 * `scope` is practice|ask|voice|reader; ask threads use the thread id as `scopeKey`.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { AUTHORED_HINT_RUNG, type Rung } from '@/lib/learning/practice-evidence'
import { applyTutorEvent, nextCheckedAnswer, nextChecks, type CheckCounts, type TutorEvent } from './state'

export type TutorScope = 'practice' | 'ask' | 'voice' | 'reader'

export type StoredTutorState = CheckCounts & {
  rung: Rung
  maxRung: Rung
  attempts: number
  lowEffortTurns: number
  hintsOpened: number
  bareGuesses: number
  sameRungNoProgress: number
  /** The step or claim the last reply addressed. */
  gapId: string | null
  /** Set once the ladder reached structure or the worked analogue (rung 4 or 5). */
  revealed: boolean
  conceptIds: string[]
  /** The answer the server graded as right (the latest), the only one a reply may confirm. */
  checkedAnswer: string | null
  /** The student said "I don't know" on this step (set by `recordTutorEvent`; `saveTutorState` leaves it alone). */
  dontKnow?: boolean
}

export const EMPTY_TUTOR_STATE: StoredTutorState = {
  rung: 0,
  maxRung: 0,
  attempts: 0,
  lowEffortTurns: 0,
  hintsOpened: 0,
  bareGuesses: 0,
  sameRungNoProgress: 0,
  checks: 0,
  wrongChecks: 0,
  lastCheckWrong: false,
  checkedCorrect: false,
  gapId: null,
  revealed: false,
  conceptIds: [],
  checkedAnswer: null,
  dontKnow: false,
}

const asRung = (value: number): Rung => Math.min(5, Math.max(0, Math.trunc(value))) as Rung

const fromRow = (row: Prisma.TutorStateGetPayload<object>): StoredTutorState => ({
  rung: asRung(row.rung),
  maxRung: asRung(row.maxRung),
  attempts: row.attempts,
  lowEffortTurns: row.lowEffortTurns,
  hintsOpened: row.hintsOpened,
  bareGuesses: row.bareGuesses,
  sameRungNoProgress: row.sameRungNoProgress,
  checks: row.checks,
  wrongChecks: row.wrongChecks,
  lastCheckWrong: row.lastCheckWrong,
  checkedCorrect: row.checkedCorrect,
  gapId: row.gapId,
  revealed: row.revealed,
  conceptIds: row.conceptIds,
  checkedAnswer: row.checkedAnswer,
  dontKnow: row.dontKnowAt !== null,
})

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/** The stored state, or a fresh one when this conversation has none yet. */
export async function getTutorState(userId: string, scope: TutorScope, scopeKey: string): Promise<StoredTutorState> {
  const row = await prisma.tutorState.findUnique({ where: { userId_scope_scopeKey: { userId, scope, scopeKey } } })
  return row ? fromRow(row) : { ...EMPTY_TUTOR_STATE, conceptIds: [] }
}

const dataOf = (state: StoredTutorState, existing: Prisma.TutorStateGetPayload<object> | null) => {
  const maxRung = Math.max(state.maxRung, state.rung, existing?.maxRung ?? 0)
  return {
    rung: state.rung,
    maxRung,
    attempts: state.attempts,
    lowEffortTurns: state.lowEffortTurns,
    hintsOpened: Math.max(state.hintsOpened, existing?.hintsOpened ?? 0),
    bareGuesses: state.bareGuesses,
    sameRungNoProgress: state.sameRungNoProgress,
    checks: state.checks,
    wrongChecks: state.wrongChecks,
    lastCheckWrong: state.lastCheckWrong,
    checkedCorrect: state.checkedCorrect || !!existing?.checkedCorrect,
    gapId: state.gapId,
    revealed: state.revealed || maxRung >= 4 || !!existing?.revealed,
    conceptIds: state.conceptIds,
    checkedAnswer: state.checkedAnswer ?? existing?.checkedAnswer ?? null,
  }
}

/**
 * Writes the state, keeping `revealed` once set and the highest rung and hint count from falling.
 * Two first saves of one conversation can race on the unique key; the loser retries once as an update.
 */
export async function saveTutorState(
  userId: string,
  scope: TutorScope,
  scopeKey: string,
  state: StoredTutorState
): Promise<StoredTutorState> {
  const where = { userId_scope_scopeKey: { userId, scope, scopeKey } }
  const write = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.tutorState.findUnique({ where })
      const data = dataOf(state, existing)
      return tx.tutorState.upsert({ where, create: { userId, scope, scopeKey, ...data }, update: data })
    })
  try {
    return fromRow(await write())
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return fromRow(await write())
  }
}

/**
 * Applies one event to the stored state and saves the result. The row is locked for the read and
 * write, so two events for one conversation (a double submit) apply one after the other instead of
 * both starting from the same state. Returns the new state, the one before it, and the flags the reply needs.
 * `conceptIds` are added to the concepts the conversation has been about.
 */
export async function recordTutorEvent(
  userId: string,
  scope: TutorScope,
  scopeKey: string,
  event: TutorEvent,
  ctx: { gapId?: string | null; progressed?: boolean; conceptIds?: readonly string[]; helpRung?: number } = {}
) {
  const where = { userId_scope_scopeKey: { userId, scope, scopeKey } }
  const run = () =>
    prisma.$transaction(async (tx) => {
      // Make sure the row exists, then lock it. A racing first insert loses on the unique key.
      await tx.tutorState.upsert({ where, create: { userId, scope, scopeKey }, update: {} })
      await tx.$queryRaw`SELECT id FROM tutor_states WHERE user_id = ${userId} AND scope = ${scope} AND scope_key = ${scopeKey} FOR UPDATE`
      const existing = await tx.tutorState.findUniqueOrThrow({ where })
      const applied = applyTutorEvent(fromRow(existing), event, ctx)
      const conceptIds = [...new Set([...existing.conceptIds, ...(ctx.conceptIds ?? [])])]
      const counts = checkCounts(fromRow(existing), event)
      // The help actually given (an opened hint, a reply's rung, the worked example) and the help level at the
      // first wrong check: practice evidence reads them (lib/learning/practice-server.ts).
      const helpRung = Math.max(existing.helpRung, ctx.helpRung ?? 0, event.type === 'hint_opened' ? AUTHORED_HINT_RUNG[event.index] : 0)
      const firstMissRung = existing.firstMissRung ?? (counts.wrongChecks > existing.wrongChecks && existing.wrongChecks === 0 ? existing.helpRung : null)
      const data = {
        ...dataOf({ ...fromRow(existing), ...applied, ...counts, checkedAnswer: nextCheckedAnswer(fromRow(existing), event), gapId: applied.gapId ?? null, conceptIds }, existing),
        helpRung,
        firstMissRung,
        // The first "I don't know" on the step (spec 18.3): practice evidence records the step as a cue miss.
        dontKnowAt: existing.dontKnowAt ?? (event.type === 'dont_know' ? new Date() : null),
      }
      const row = await tx.tutorState.update({ where, data })
      return {
        state: fromRow(row),
        /** The state this event was applied to, read under the lock (a caller can tell the first use of a rung). */
        before: fromRow(existing),
        askWhatIsUnclear: applied.askWhatIsUnclear,
        workedAllowed: applied.workedAllowed,
        offerWorked: applied.offerWorked,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return run()
  }
}

/**
 * Starts the conversation's ladder again (a new problem in the same thread): every count back to zero. The concepts it
 * has been about are kept. A conversation with no row has nothing to reset.
 */
export async function resetTutorState(userId: string, scope: TutorScope, scopeKey: string): Promise<void> {
  await prisma.tutorState.updateMany({
    where: { userId, scope, scopeKey },
    data: {
      rung: 0,
      maxRung: 0,
      attempts: 0,
      lowEffortTurns: 0,
      hintsOpened: 0,
      bareGuesses: 0,
      sameRungNoProgress: 0,
      checks: 0,
      wrongChecks: 0,
      lastCheckWrong: false,
      checkedCorrect: false,
      checkedAnswer: null,
      helpRung: 0,
      firstMissRung: null,
      dontKnowAt: null,
      gapId: null,
      revealed: false,
    },
  })
}

/** The check counts after this event: only those four fields, so they never overwrite the rest of the state. */
const checkCounts = (state: CheckCounts, event: TutorEvent): CheckCounts => {
  const next = nextChecks(state, event)
  return { checks: next.checks, wrongChecks: next.wrongChecks, lastCheckWrong: next.lastCheckWrong, checkedCorrect: next.checkedCorrect }
}

/**
 * Starts a conversation about concepts the student chose (the knowledge map's "Ask about this"): they are the
 * concepts the conversation has been about from its first turn, before any question has been routed. Adds to the
 * concepts already stored and changes nothing else.
 */
export async function seedTutorConcepts(userId: string, scope: TutorScope, scopeKey: string, conceptIds: readonly string[]): Promise<void> {
  const where = { userId_scope_scopeKey: { userId, scope, scopeKey } }
  const run = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.tutorState.findUnique({ where, select: { conceptIds: true } })
      const merged = [...new Set([...(existing?.conceptIds ?? []), ...conceptIds])]
      await tx.tutorState.upsert({ where, create: { userId, scope, scopeKey, conceptIds: merged }, update: { conceptIds: merged } })
    })
  try {
    await run()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await run()
  }
}
