/**
 * The tutor's rung state machine (spec §6.2): pure transitions on the hint ladder and the choice of
 * the next move. The server holds the state (store.ts); the model only writes the words.
 */

import { isDontKnow } from '@/lib/learning/dont-know'
import { AUTHORED_HINT_RUNG, type Rung } from '@/lib/learning/practice-evidence'

export type TutorEvent =
  // One submission is one event: pass its text and, when it was checked, `correct` together, so it
  // climbs at most one rung. Use `checked` alone only when there is no text to read.
  | { type: 'attempt'; text: string; correct?: boolean }
  | { type: 'checked'; correct: boolean }
  | { type: 'request' }
  | { type: 'hint_opened'; index: 0 | 1 | 2 }
  | { type: 'clarify' }
  | { type: 'show_worked' }
  // The "I don't know" button (spec 18.3): an attempt that is wrong. It counts as the step's first check and as an
  // attempt, and leaves the rung where it is: nothing was tried, so nothing is climbed.
  | { type: 'dont_know' }

export type RungState = {
  rung: Rung
  maxRung: Rung
  attempts: number
  lowEffortTurns: number
  hintsOpened: number
}

export type RungResult = RungState & {
  /** Three low-effort turns: ask which part of the last hint is unclear before anything else. */
  askWhatIsUnclear: boolean
  /** The "Show me a worked example" button may appear: at least one genuine attempt. */
  workedAllowed: boolean
  /** True once, on the attempt that makes the third failed one: the tutor may mention the button. */
  offerWorked: boolean
}

export type MissKind = 'cue_miss' | 'discrimination' | 'execution' | 'careless' | 'misconception'

export type TutorMove =
  | 'clarify'
  | 'orient'
  | 'ladder'
  | 'confront'
  | 'confirm'
  | 'reason_first'
  | 'to_source'
  | 'worked_analogue'

const MIN_ATTEMPT_CHARS = 12
const LOW_EFFORT_LIMIT = 3
const WORKED_OFFER_AT = 3
/** Attempts climb to structure at most; the worked analogue (rung 5) is the student's button. */
const HIGHEST_ATTEMPT_RUNG: Rung = 4

/** At least 12 characters of reasoning beyond a request for help (padded or not). */
export function isGenuineAttempt(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_ATTEMPT_CHARS) return false
  return !isDontKnow(trimmed)
}

/**
 * A short, value-only reply with no reasoning ("42", "x = 3", "B"). Not low effort: "idk" asks for
 * help, a bare guess answers without saying why (spec 6.2, reason before checking).
 */
export function isBareGuess(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length >= MIN_ATTEMPT_CHARS || isDontKnow(trimmed)) return false
  return (trimmed.match(/\p{L}{3,}/gu) ?? []).length <= 1
}

const rungAtLeast = (rung: Rung, floor: Rung): Rung => (rung >= floor ? rung : floor)
const climb = (rung: Rung): Rung => (rung >= HIGHEST_ATTEMPT_RUNG ? rung : ((rung + 1) as Rung))

export function nextRung(state: RungState, event: TutorEvent): RungResult {
  let { rung, attempts, lowEffortTurns, hintsOpened } = state
  let offerWorked = false

  // A genuine attempt, or a checked wrong answer: one rung up at most, and it ends a low-effort run.
  const genuineFailure = () => {
    attempts += 1
    lowEffortTurns = 0
    rung = climb(rung)
    offerWorked = attempts === WORKED_OFFER_AT
  }

  switch (event.type) {
    case 'attempt':
      // A correct submission is neither a failure nor a low-effort turn; lowEffortTurns stays as it was.
      if (event.correct === true) break
      // An empty submission is not a wrong answer: nothing was tried, so no rung is earned by it.
      if (event.text.trim() === '' && event.correct === false) break
      if (event.correct === false || isGenuineAttempt(event.text)) genuineFailure()
      else lowEffortTurns += 1
      break
    case 'checked':
      if (!event.correct) genuineFailure()
      break
    case 'request':
      lowEffortTurns += 1
      break
    case 'dont_know':
      // An attempt, not a climb and not a low-effort turn.
      attempts += 1
      lowEffortTurns = 0
      offerWorked = attempts === WORKED_OFFER_AT
      break
    case 'hint_opened':
      rung = rungAtLeast(rung, AUTHORED_HINT_RUNG[event.index])
      hintsOpened = Math.max(hintsOpened, event.index + 1)
      break
    case 'show_worked':
      if (attempts >= 1) rung = 5
      break
    case 'clarify':
      break
  }

  return {
    rung,
    maxRung: rungAtLeast(state.maxRung, rung),
    attempts,
    lowEffortTurns,
    hintsOpened,
    askWhatIsUnclear: lowEffortTurns >= LOW_EFFORT_LIMIT,
    workedAllowed: attempts >= 1,
    offerWorked,
  }
}

export type TutorCounters = { bareGuesses: number; sameRungNoProgress: number }

export type CounterContext = {
  rungBefore: Rung
  rungAfter: Rung
  /** The step or claim this reply addressed, and the one the previous reply addressed. */
  gapId?: string | null
  prevGapId?: string | null
  /** The reply moved the student forward (a correct step, a new correct idea). */
  progressed: boolean
}

/**
 * The two counters nextMove reads. A bare value adds to bareGuesses and a reply with reasoning
 * clears it. A reply at the same rung on the same gap without progress adds to sameRungNoProgress;
 * a rung change, a new gap or progress clears it. Clarifying and opening a hint are not replies.
 */
export function nextCounters(prev: TutorCounters, event: TutorEvent, ctx: CounterContext): TutorCounters {
  const correct = (event.type === 'checked' || event.type === 'attempt') && event.correct === true
  let { bareGuesses, sameRungNoProgress } = prev

  if (event.type === 'attempt') {
    if (correct || isGenuineAttempt(event.text)) bareGuesses = 0
    else if (isBareGuess(event.text)) bareGuesses += 1
  } else if (correct) {
    bareGuesses = 0
  }

  const isReply = event.type === 'attempt' || event.type === 'checked' || event.type === 'request'
  const newGap = ctx.gapId != null && ctx.gapId !== ctx.prevGapId
  if (correct || ctx.progressed || newGap || ctx.rungAfter !== ctx.rungBefore) sameRungNoProgress = 0
  else if (isReply) sameRungNoProgress += 1

  return { bareGuesses, sameRungNoProgress }
}

export type AppliedState = RungState & TutorCounters & { gapId?: string | null }

/** nextRung and nextCounters together, so a caller cannot update one and forget the other. */
export function applyTutorEvent(
  state: AppliedState,
  event: TutorEvent,
  ctx: { gapId?: string | null; progressed?: boolean }
): AppliedState & Pick<RungResult, 'askWhatIsUnclear' | 'workedAllowed' | 'offerWorked'> {
  const rung = nextRung(state, event)
  const gapId = ctx.gapId === undefined ? (state.gapId ?? null) : ctx.gapId
  const counters = nextCounters(state, event, {
    rungBefore: state.rung,
    rungAfter: rung.rung,
    gapId,
    prevGapId: state.gapId ?? null,
    progressed: ctx.progressed ?? false,
  })
  return { ...rung, ...counters, gapId }
}

export type MoveState = {
  rung: Rung
  attempts: number
  lowEffortTurns: number
  /** Guesses in a row with no reasoning. */
  bareGuesses: number
  /** Replies at the same rung on the same gap without progress. */
  sameRungNoProgress: number
}

export type MoveSignals = {
  event: TutorEvent
  lastWrong: boolean
  missKind?: MissKind
  confident?: boolean
  justSolvedWithHints: boolean
}

/** The move for the next reply, first match wins (spec §6.2). Fork is the `ladder` move at rung 2. */
export function nextMove(state: MoveState, signals: MoveSignals): TutorMove {
  const { event } = signals
  if (event.type === 'clarify') return 'clarify'
  if (event.type === 'show_worked' && state.attempts >= 1) return 'worked_analogue'
  if (signals.lastWrong && (signals.missKind === 'misconception' || signals.confident)) return 'confront'
  if (signals.justSolvedWithHints) return 'confirm'
  if (state.bareGuesses >= 2) return 'reason_first'
  if (state.sameRungNoProgress >= 2) return 'to_source'
  if (state.rung === 0) return 'orient'
  return 'ladder'
}

/** The answer text the server graded as right: kept from the latest correct check, never from the browser's own list. */
export function nextCheckedAnswer(prev: { checkedAnswer: string | null }, event: TutorEvent): string | null {
  return event.type === 'attempt' && event.correct === true && event.text.trim() ? event.text.trim() : prev.checkedAnswer
}

export type GateEvent = TutorEvent | { type: 'reveal' }

/**
 * The hint gate (spec 18.4): locate (rung 1) is open from the start; Connect and Structure, the worked example and
 * Show answer open only after one attempt on the step, a checked answer or the IDK button. `checks` is the server's
 * count (`nextChecks`), which includes an IDK. The tutor route answers a refusal with 409 ATTEMPT_FIRST.
 */
export function gateHelp(state: { checks: number }, event: GateEvent): { ok: true } | { ok: false; code: 'ATTEMPT_FIRST' } {
  const gated = (event.type === 'hint_opened' && event.index >= 1) || event.type === 'show_worked' || event.type === 'reveal'
  return gated && state.checks < 1 ? { ok: false, code: 'ATTEMPT_FIRST' } : { ok: true }
}

export type CheckCounts = { checks: number; wrongChecks: number; lastCheckWrong: boolean; checkedCorrect: boolean }

/**
 * What the server has seen of the student's checked answers on the step. An event carries `correct`
 * only when it is a check (a question about the working has none), so only checks count. The browser
 * grades nothing here: the route grades the answer itself before it builds the event.
 */
export function nextChecks(prev: CheckCounts, event: TutorEvent): CheckCounts {
  // "I don't know" is the step's check, wrong (spec 3.3): it opens the help like a wrong answer does.
  if (event.type === 'dont_know') return { checks: prev.checks + 1, wrongChecks: prev.wrongChecks + 1, lastCheckWrong: true, checkedCorrect: prev.checkedCorrect }
  if ((event.type !== 'attempt' && event.type !== 'checked') || event.correct === undefined) return prev
  // A check with nothing written counts as no check, or an empty box would open "Ask about my working".
  if (event.type === 'attempt' && event.text.trim() === '') return prev
  return event.correct
    ? { checks: prev.checks + 1, wrongChecks: prev.wrongChecks, lastCheckWrong: false, checkedCorrect: true }
    : { checks: prev.checks + 1, wrongChecks: prev.wrongChecks + 1, lastCheckWrong: true, checkedCorrect: prev.checkedCorrect }
}
