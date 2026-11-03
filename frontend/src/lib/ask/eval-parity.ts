/**
 * What the Ask eval's Python mirror (evals/tutoring/ask_state.py) must reproduce: the real Ask logic run over
 * the eval's scripted students. The eval calls the AI service directly, so the tutor state sent with each
 * question, the exam guard's decline and what a reply records come from that mirror. This runs the same turns
 * through `examGuard`, `planAskTurn`, `tutorEventFor`, `rungUsed`, `replyTaught` and `applyTutorEvent`, with the
 * route each turn is scripted to get standing in for the router, so a change here that the mirror misses fails
 * a test on both sides.
 *
 * `scripts/ask-parity-fixture.ts` writes the fixture; `eval-parity.test.ts` checks it is current;
 * `evals/tutoring/test_ask_state.py` checks the Python reproduces it.
 */

import { applyTutorEvent, nextChecks, type CheckCounts } from '@/lib/tutor/state'
import { EMPTY_TUTOR_STATE, type StoredTutorState } from '@/lib/tutor/store'
import { deliveredUnderstandMode, nextUnderstand, planAskTurn, replyTaught, rungUsed, tutorEventFor, type AskPlan, type UnderstandCounter } from './ask-turn'
import type { Band } from '@/lib/learning/level'
import { examGuard, examQuestionTexts } from './exam-guard'
import { EXAM_GUARD_NOTE } from './exam-guard-server'
import { WORKED_EXAMPLE_REQUEST, type AskIntent, type AskRoute } from './tutor-message'

export const EXAM_GUARD_REPLY = "That looks like a question from the mock exam you're taking. Finish it first, then ask me."
/** Earlier messages sent along with a question (lib/chat/server.ts HISTORY_MESSAGES). */
const HISTORY_MESSAGES = 6

type ScriptedRoute = { intent: AskIntent; has_attempt?: boolean; wants_answer?: boolean; broad?: boolean; degraded?: boolean; concept_ids?: string[] }

export type AskScenario = {
  id: string
  /** The support band of the thread's concepts (no database here to compute it); core when absent. */
  band?: Band
  open_exam?: { question_text: string; options?: { id: string; text: string }[] }[]
  turns: {
    event: 'ask' | 'show_worked' | 'card'
    message?: string
    grade?: 'got_it' | 'partly' | 'missed'
    route?: ScriptedRoute
    stop_reason?: string
    reply?: string
  }[]
}

export type AskTurnTrace = {
  turn: number
  event: string
  declined?: boolean
  blocked?: boolean
  tutor?: unknown
  history?: { role: string; content: string }[]
  rung_used?: number
  taught?: boolean
  rung_after?: number
  attempts?: number
  low_effort_turns?: number
  understand_no_attempt?: number
  checked_correct: boolean
}

const pickChecks = (state: CheckCounts) => ({
  checks: state.checks,
  wrongChecks: state.wrongChecks,
  lastCheckWrong: state.lastCheckWrong,
  checkedCorrect: state.checkedCorrect,
})

const toRoute = (route: ScriptedRoute): AskRoute => ({
  intent: route.intent,
  hasAttempt: route.has_attempt === true,
  wantsAnswer: route.wants_answer === true,
  concepts: [],
  conceptIds: route.concept_ids ?? [],
  broad: route.broad === true,
  degraded: route.degraded === true,
})

/** One scenario played through the server's logic (the chat route and ask-turn.ts, without the database and the model). */
export function traceAskScenario(scenario: AskScenario): AskTurnTrace[] {
  let state: StoredTutorState = { ...EMPTY_TUTOR_STATE, conceptIds: [] }
  const history: { role: string; content: string }[] = []
  const open = examQuestionTexts((scenario.open_exam ?? []).map((question) => ({ ...question })))
  const out: AskTurnTrace[] = []
  let counter: UnderstandCounter = { noAttempt: 0, concepts: [] }
  const band: Band = scenario.band ?? 1

  scenario.turns.forEach((turn, index) => {
    const base = { turn: index + 1, event: turn.event }
    if (turn.event === 'card') {
      // A card's grade is the student's own: it changes nothing in the thread's state (ask-check.ts).
      out.push({ ...base, checked_correct: state.checkedCorrect })
      return
    }
    const kind = turn.event === 'show_worked' ? 'show_worked' : 'ask'
    const question = kind === 'show_worked' ? WORKED_EXAMPLE_REQUEST : (turn.message ?? '').trim()
    const recent = history.filter((message) => message.role === 'user' && message.content !== EXAM_GUARD_NOTE).map((message) => message.content)
    if (kind === 'ask' && examGuard(question, open, recent)) {
      history.push({ role: 'user', content: EXAM_GUARD_NOTE }, { role: 'assistant', content: EXAM_GUARD_REPLY })
      out.push({ ...base, declined: true, checked_correct: state.checkedCorrect })
      return
    }
    const planned = planAskTurn(state, question, kind, recent, { ...counter, band })
    if (!planned.ok) {
      out.push({ ...base, blocked: true, checked_correct: state.checkedCorrect })
      return
    }
    const plan: AskPlan = planned.plan
    const route = toRoute(turn.route ?? { intent: 'lookup' })
    const sent = history.slice(-HISTORY_MESSAGES)
    const stopReason = turn.stop_reason ?? 'end_turn'
    const taught = replyTaught(plan, route, stopReason)
    const used = rungUsed(plan, route)
    const event = tutorEventFor(plan, route)
    // A new problem starts the ladder again (finishAskTurn resets the stored state; the plan was made from the reset one).
    if (plan.fresh) state = { ...plan.before }
    counter = nextUnderstand(counter, route, deliveredUnderstandMode(plan, route))
    if (event) state = { ...state, ...applyTutorEvent(state, event, {}), ...pickChecks(nextChecks(state, event)) }
    history.push({ role: 'user', content: question }, { role: 'assistant', content: turn.reply ?? '(reply)' })
    out.push({
      ...base,
      tutor: plan.tutor,
      history: sent,
      rung_used: used,
      taught,
      rung_after: state.rung,
      attempts: state.attempts,
      low_effort_turns: state.lowEffortTurns,
      understand_no_attempt: counter.noAttempt,
      checked_correct: state.checkedCorrect,
    })
  })
  return out
}

export function askParityFixture(scenarios: AskScenario[]) {
  return scenarios.map((scenario) => ({ id: scenario.id, turns: traceAskScenario(scenario) }))
}
