/**
 * One Ask turn on the server (spec §6.3, §6.2): what the thread's tutor state allows before the model is
 * asked, and what the turn records once the reply came back. The AI service decides what a message is for;
 * this decides, from the thread's stored state, how much help that kind of message may get, and writes the
 * state and the evidence. Only the route's own words are read from the model; the level is decided here.
 */

import { prisma } from '@/lib/db/prisma'
import { recordEvidence } from '@/lib/learning/evidence'
import { itemKey } from '@/lib/learning/item-key'
import { askExplainThreshold, type Band } from '@/lib/learning/level'
import type { Rung } from '@/lib/learning/practice-evidence'
import { lowestBand } from '@/lib/tutor/band-server'
import { applyTutorEvent, type TutorEvent } from '@/lib/tutor/state'
import { EMPTY_TUTOR_STATE, getTutorState, recordTutorEvent, resetTutorState, type StoredTutorState } from '@/lib/tutor/store'
import { tokens } from './exam-guard'
import type { AskRoute } from './tutor-message'

export { WORKED_EXAMPLE_REQUEST } from './tutor-message'

/** What the student's message is: a question, or the "Show me a worked example" button. */
export type AskKind = 'ask' | 'show_worked'

/** The state sent with the question (ai-service `tutor`): the state now, and the state if the message is the student's attempt. */
export type AskTutorBody = {
  rung: Rung
  final_allowed: boolean
  ask_what_is_unclear: boolean
  attempt_rung: Rung
  attempt_ask_what_is_unclear: boolean
  /** The student's button: the AI service takes the turn for a solve turn at rung 5 without asking the router. */
  show_worked?: true
  /** The mode of an `understand` turn that is not broad, when the message is no attempt (the router decides that, so both are sent). */
  understand_mode?: UnderstandPlanMode
  /** The mode of that turn when the router finds the student's attempt in the message. */
  attempt_understand_mode?: 'explain'
}

/** The modes of an `understand` reply (spec 6.3, 18.6). `entry_points` is the router's call on a broad question, never planned here. */
export type UnderstandMode = 'commit' | 'explain' | 'explain_short' | 'entry_points'
export type UnderstandPlanMode = 'commit' | 'explain_short'

/** What counts the thread's `understand` turns with no attempt (the TutorState columns `understandNoAttempt` and `understandConcepts`). */
export type UnderstandCounter = { noAttempt: number; concepts: readonly string[] }
/** The counter and the band of its concepts (`lowestBand`), which sets the threshold. */
export type UnderstandInput = UnderstandCounter & { band: Band }

export const EMPTY_UNDERSTAND: UnderstandInput = { noAttempt: 0, concepts: [], band: 0 }

/**
 * The mode a non-attempt `understand` turn is written in: a short explanation once the earlier turns on these
 * concepts have reached the threshold (one in band 0, else two), and today's question for the student's own thinking before that.
 */
export function understandModeFor(input: UnderstandInput): UnderstandPlanMode {
  return input.noAttempt >= askExplainThreshold(input.band) ? 'explain_short' : 'commit'
}

/** The mode the reply was actually written in, from the plan and the route the router found. */
export function deliveredUnderstandMode(plan: Pick<AskPlan, 'tutor'>, route: AskRoute): UnderstandMode | null {
  if (route.intent !== 'understand') return null
  if (route.broad) return 'entry_points'
  if (route.hasAttempt) return 'explain'
  return plan.tutor.understand_mode ?? 'commit'
}

/**
 * The counter after an `understand` turn (spec 18.6). An attempt resets it, and so does a short explanation (the
 * student has been helped); otherwise the turn adds one when it is about the concepts counted so far (or none have
 * been counted, or the router named none), and restarts the count at 1 on new ones. Broad, degraded and other-intent
 * turns do not count.
 */
export function nextUnderstand(prev: UnderstandCounter, route: AskRoute, delivered: UnderstandMode | null): UnderstandCounter {
  if (route.intent !== 'understand' || route.degraded || route.broad) return prev
  const routed = route.conceptIds
  if (route.hasAttempt || delivered === 'explain_short') return { noAttempt: 0, concepts: routed.length > 0 ? routed : prev.concepts }
  const continues = prev.concepts.length === 0 || routed.length === 0 || routed.some((id) => prev.concepts.includes(id))
  if (!continues) return { noAttempt: 1, concepts: routed }
  return { noAttempt: prev.noAttempt + 1, concepts: [...new Set([...prev.concepts, ...routed])] }
}

export type AskPlan = {
  kind: AskKind
  question: string
  before: StoredTutorState
  tutor: AskTutorBody
  /** The message starts a new problem: the thread's ladder begins again (the state is per thread, a problem is not). */
  fresh: boolean
  /** What the student wrote earlier in the thread, for telling a repeated attempt from a new one. */
  prior: readonly string[]
  /** The thread's count of understand turns with no attempt before this message. */
  understandBefore: UnderstandCounter
}

/** A message this long, with a number or an equals sign, reads as a problem statement. */
const PROBLEM_MIN_CHARS = 40
/** Under this share of the shorter message's words in common with every earlier message, it is about something else. */
const NEW_PROBLEM_OVERLAP = 0.25

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** A message in the student's own voice ("I tried ...", "my answer") is their work on a problem, not a new problem. */
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|we)\b/i
/** A message that opens as a request to work something out is a problem put to the tutor, whoever is speaking. */
const OPENS_AS_REQUEST = /^\s*(?:please|pls|can you|could you|would you|help|solve|find|calculate|compute|determine|what is|what's|how (?:do|many|much)|give me)\b/i

/**
 * True when the message looks like a new problem put to the tutor: a statement with a quantity in it that has little in
 * common with anything the student wrote earlier in the thread, and is not the student's own work. The ladder belongs
 * to a problem, but the stored state is the thread's, so a rung climbed on one problem would otherwise carry to the next.
 */
export function isNewProblem(question: string, prior: readonly string[]): boolean {
  if (prior.length === 0 || question.trim().length < PROBLEM_MIN_CHARS || !/\d|=/.test(question)) return false
  if (FIRST_PERSON.test(question) && !OPENS_AS_REQUEST.test(question)) return false
  const words = tokens(question)
  return prior.every((earlier) => overlap(words, tokens(earlier)) < NEW_PROBLEM_OVERLAP)
}

/** The same attempt again, however it is spaced or cased: padding the thread with it earns nothing. */
export function isRepeat(question: string, prior: readonly string[]): boolean {
  const words = tokens(question)
  if (words.size === 0) return false
  return prior.some((earlier) => {
    const other = tokens(earlier)
    return other.size > 0 && overlap(words, other) >= 0.9 && Math.abs(words.size - other.size) <= Math.max(1, Math.floor(other.size * 0.2))
  })
}

export type PlanResult = { ok: true; plan: AskPlan } | { ok: false; reason: 'not_allowed' }

/**
 * Rung 5 is the student's button and belongs to that turn alone: a later message in the thread is answered at
 * structure at most, or the follow-up to a worked example would be another worked example.
 */
const HIGHEST_ORDINARY_RUNG: Rung = 4
const capped = (rung: Rung): Rung => (rung > HIGHEST_ORDINARY_RUNG ? HIGHEST_ORDINARY_RUNG : rung)

/**
 * The state a reply is written at. The router decides whether the message is the student's attempt, so both
 * states are sent: as a request that only asks for help (it never climbs) and as an attempt (it climbs one rung
 * at most). `final_allowed` is always false: Ask has no authored key and the only grade it holds is the
 * student's own, so the server never has a verified correct answer to the student's problem (spec 6.2).
 */
export function planAskTurn(
  stored: StoredTutorState,
  question: string,
  kind: AskKind,
  prior: readonly string[] = [],
  understand: UnderstandInput = EMPTY_UNDERSTAND
): PlanResult {
  const fresh = kind === 'ask' && isNewProblem(question, prior)
  const before: StoredTutorState = fresh ? { ...EMPTY_TUTOR_STATE, conceptIds: stored.conceptIds } : stored
  if (kind === 'show_worked') {
    // A worked example needs one genuine attempt first (spec 6.2).
    if (!applyTutorEvent(before, { type: 'show_worked' }, {}).workedAllowed) return { ok: false, reason: 'not_allowed' }
    return { ok: true, plan: { kind, question, before, fresh, prior, understandBefore: understand, tutor: { rung: 5, final_allowed: false, ask_what_is_unclear: false, attempt_rung: 5, attempt_ask_what_is_unclear: false, show_worked: true } } }
  }
  const asRequest = applyTutorEvent(before, { type: 'request' }, {})
  const asAttempt = applyTutorEvent(before, { type: 'attempt', text: question }, {})
  return {
    ok: true,
    plan: {
      kind,
      question,
      before,
      fresh,
      prior,
      understandBefore: understand,
      tutor: {
        rung: capped(asRequest.rung),
        final_allowed: false,
        ask_what_is_unclear: asRequest.askWhatIsUnclear,
        attempt_rung: capped(asAttempt.rung),
        attempt_ask_what_is_unclear: asAttempt.askWhatIsUnclear,
        understand_mode: understandModeFor(understand),
        attempt_understand_mode: 'explain',
      },
    },
  }
}

/** The thread's stored state; a thread that does not exist yet has none. */
export const loadAskState = (userId: string, threadId: string | null): Promise<StoredTutorState> =>
  threadId ? getTutorState(userId, 'ask', threadId) : Promise.resolve({ ...EMPTY_TUTOR_STATE, conceptIds: [] })

/** The thread's count of understand turns with no attempt, with the band of the concepts it counts (which sets the threshold). */
export async function loadUnderstand(userId: string, threadId: string | null): Promise<UnderstandInput> {
  if (!threadId) return EMPTY_UNDERSTAND
  const row = await prisma.tutorState.findUnique({
    where: { userId_scope_scopeKey: { userId, scope: 'ask', scopeKey: threadId } },
    select: { understandNoAttempt: true, understandConcepts: true },
  })
  if (!row || row.understandNoAttempt === 0) return EMPTY_UNDERSTAND
  return { noAttempt: row.understandNoAttempt, concepts: row.understandConcepts, band: await lowestBand(userId, row.understandConcepts) }
}

/** Writes the thread's understand counter after a turn, on the columns the shared tutor store does not carry. */
async function saveUnderstand(userId: string, threadId: string, counter: UnderstandCounter): Promise<void> {
  const data = { understandNoAttempt: counter.noAttempt, understandConcepts: [...counter.concepts] }
  await prisma.tutorState.upsert({
    where: { userId_scope_scopeKey: { userId, scope: 'ask', scopeKey: threadId } },
    create: { userId, scope: 'ask', scopeKey: threadId, ...data },
    update: data,
  })
}
/**
 * The one event this student turn is, once the route is known. Only solve turns use the ladder: an attempt climbs at
 * most a rung, a message with no attempt in it adds to the low-effort turns. Checking an answer does not climb it,
 * because the server cannot know whether the answer was right (a wrong one would count as a failure and a right one
 * would be punished with more help); lookups, logistics, explanations and chat do not move it either.
 */
export function tutorEventFor(plan: Pick<AskPlan, 'kind' | 'question'> & { prior?: readonly string[] }, route: AskRoute): TutorEvent | null {
  if (route.degraded) return null
  if (plan.kind === 'show_worked') return route.intent === 'solve' ? { type: 'show_worked' } : null
  if (route.intent !== 'solve') return null
  // The router decides whether the message is an attempt, and a model can be talked into it: an attempt that repeats an
  // earlier message is only a request, so repeating one cannot climb the ladder.
  if (route.hasAttempt && !isRepeat(plan.question, plan.prior ?? [])) return { type: 'attempt', text: plan.question }
  return { type: 'request' }
}

/** The rung the reply was written at. */
export function rungUsed(plan: AskPlan, route: AskRoute): Rung {
  return plan.kind === 'show_worked' ? 5 : route.hasAttempt ? plan.tutor.attempt_rung : plan.tutor.rung
}

/**
 * Whether the reply taught the concepts, which makes it level 3: an explanation of the gap after the student's
 * attempt, a short explanation after repeated non-attempts (`explain_short`), or a solve reply that gave structure
 * or a worked example (rung 4 or 5, spec 3.3). A question back, the places to start for a broad question, and a
 * reply that fell back to asking for the work teach nothing.
 */
export function replyTaught(plan: AskPlan, route: AskRoute, stopReason: string): boolean {
  if (route.degraded || stopReason === 'leak_fallback') return false
  if (route.intent === 'understand') {
    const mode = deliveredUnderstandMode(plan, route)
    return mode === 'explain' || mode === 'explain_short'
  }
  if (route.intent === 'solve') return rungUsed(plan, route) >= 4
  return false
}

/** The routed concepts that are the student's own, active, with their topics, in routed order. */
async function ownConcepts(userId: string, projectId: string, ids: readonly string[]) {
  if (ids.length === 0) return []
  const found = await prisma.concept.findMany({
    where: { id: { in: [...ids] }, projectId, status: 'active', project: { userId } },
    select: { id: true, topicId: true },
  })
  const byId = new Map(found.map((concept) => [concept.id, concept]))
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}

/** Level 3 on the concepts a reply taught: the AI carried it, so no review and no score; the next review is pulled to tomorrow. */
export async function recordExplained(input: {
  userId: string
  projectId: string
  threadId: string
  messageId: string
  conceptIds: readonly string[]
  intent: string
  rung: Rung
  surrendered: boolean
  timeZone: string
}): Promise<boolean> {
  const concepts = await ownConcepts(input.userId, input.projectId, input.conceptIds)
  if (concepts.length === 0) return false
  await recordEvidence(
    [
      {
        userId: input.userId,
        projectId: input.projectId,
        topicId: concepts[0].topicId,
        itemKey: `${itemKey({ kind: 'ask', threadId: input.threadId, messageId: input.messageId })}:explained`,
        conceptIds: concepts.map((concept) => concept.id),
        source: 'ask_check',
        score: 0,
        assistance: 3,
        gradedBy: 'rule',
        sessionKey: `ask-explain:${input.messageId}`,
        metadata: { threadId: input.threadId, messageId: input.messageId, intent: input.intent, rung: input.rung, explained: true, ...(input.surrendered ? { surrendered: true } : {}) },
      },
    ],
    { timeZone: input.timeZone, userId: input.userId, skipIfPresent: true }
  )
  return true
}

export type FinishedTurn = { workedAllowed: boolean }

/**
 * After a reply is stored: the thread's state moves by the one event this turn was, and a reply that taught
 * records its level-3 evidence. The state is written after the reply came back, so a failed reply costs the
 * student no rung. Returns whether the "Show me a worked example" button may be offered.
 */
export async function finishAskTurn(input: {
  userId: string
  projectId: string
  threadId: string
  messageId: string
  plan: AskPlan
  route: AskRoute | null
  stopReason: string
  timeZone: string
}): Promise<FinishedTurn> {
  const { userId, projectId, threadId, messageId, plan, route } = input
  // A new problem starts the ladder again, whatever the reply was.
  if (plan.fresh) await resetTutorState(userId, 'ask', threadId)
  if (!route) return { workedAllowed: plan.before.attempts >= 1 }

  // The evidence comes before the state, so a failed evidence write leaves the rung where it was.
  if (replyTaught(plan, route, input.stopReason)) {
    await recordExplained({
      userId,
      projectId,
      threadId,
      messageId,
      // The button's turn names no concept of its own: it is about what the conversation has been about.
      conceptIds: route.conceptIds.length > 0 ? route.conceptIds : plan.kind === 'show_worked' ? plan.before.conceptIds : [],
      intent: route.intent,
      rung: rungUsed(plan, route),
      surrendered: plan.kind === 'show_worked' && plan.before.maxRung < 5,
      timeZone: input.timeZone,
    })
  }
  // The understand counter moves after the reply, like the rung: a failed reply costs the student no turn.
  const counted = nextUnderstand(plan.understandBefore, route, deliveredUnderstandMode(plan, route))
  if (counted !== plan.understandBefore) await saveUnderstand(userId, threadId, counted)
  const event = tutorEventFor(plan, route)
  if (!event) {
    const state = await getTutorState(userId, 'ask', threadId)
    return { workedAllowed: state.attempts >= 1 }
  }
  const recorded = await recordTutorEvent(userId, 'ask', threadId, event, { conceptIds: route.conceptIds })
  return { workedAllowed: recorded.workedAllowed }
}
