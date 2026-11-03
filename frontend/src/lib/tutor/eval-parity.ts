/**
 * What the tutoring eval's Python mirror (evals/tutoring/app_state.py) must reproduce: the real tutor
 * logic run over the eval's scripted students. The eval calls the AI service directly, so the move,
 * the rung and the request of each turn come from that mirror; this runs the same turns through
 * `applyTutorEvent`, `nextMove`, `firstWrongStep`, `checkPracticeAnswer` and `buildPracticeTutorRequest`
 * so a change here that the mirror misses fails a test on both sides.
 *
 * `scripts/tutoring-parity-fixture.ts` writes the fixture; `eval-parity.test.ts` checks it is current;
 * `evals/tutoring/test_app_state.py` checks the Python reproduces it.
 */

import { checkPracticeAnswer } from '@/features/topic/practice-check'
import type { PracticeProblem, PracticeStep } from '@/features/topic/types'
import { firstWrongStep } from './first-wrong-step'
import { buildPracticeTutorRequest, givensOf } from './practice-tutor'
import { applyTutorEvent, gateHelp, nextCheckedAnswer, nextChecks, nextMove, type CheckCounts, type TutorEvent } from './state'
import type { StoredTutorState } from './store'

export type ScenarioStep = {
  question: string
  answer: string
  acceptable_answers: string[]
  tolerance: number | null
  hints: [string, string, string]
  answer_type: 'numeric' | 'text' | 'multiple_choice'
  options?: { id: string; text: string }[]
}

export type Scenario = {
  id: string
  title: string
  statement: string
  steps: ScenarioStep[]
  step_index: number
  turns: {
    event: 'check' | 'hint' | 'ask' | 'clarify' | 'show_worked' | 'dont_know'
    answer?: string
    correct?: boolean
    index?: 0 | 1 | 2
    message?: string
    working?: string
    miss_kind?: string | null
  }[]
}

export type TurnTrace = {
  turn: number
  event: string
  /** check turns: what checkPracticeAnswer says. */
  correct?: boolean
  /** The app refused (an ask before the first check, Connect or a worked example before an attempt: ATTEMPT_FIRST). */
  blocked?: boolean
  move?: string
  rung_allowed?: number
  attempts?: number
  ask_what_is_unclear?: boolean
  offer_worked?: boolean
  first_wrong_step?: number | null
  request?: unknown
  /** The rung stored after the turn. */
  rung_after: number
}

const EMPTY: StoredTutorState = {
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
}

const pickChecks = (state: CheckCounts) => ({
  checks: state.checks,
  wrongChecks: state.wrongChecks,
  lastCheckWrong: state.lastCheckWrong,
  checkedCorrect: state.checkedCorrect,
})

export function problemOf(scenario: Scenario): PracticeProblem {
  const steps: PracticeStep[] = scenario.steps.map((step, index) => ({
    number: index + 1,
    question: step.question,
    hint: step.hints[1],
    hints: step.hints,
    conceptIds: [],
    answerType: step.answer_type,
    options: step.options ?? [],
    correctAnswer: step.answer,
    acceptableAnswers: step.acceptable_answers,
    tolerance: step.tolerance,
    explanation: '',
    feedbackCorrect: '',
    feedbackIncorrect: '',
  }))
  return { title: scenario.title, problem: scenario.statement, steps, keyConcepts: [], conceptIds: [], difficulty: null, minutes: null, sources: [] }
}

/** One scenario played through the server's logic (practice-tutor.ts runPracticeTutor, without the database and the model). */
export function traceScenario(scenario: Scenario): TurnTrace[] {
  const problem = problemOf(scenario)
  const step = problem.steps[scenario.step_index]
  const givens = givensOf(problem)
  let state: StoredTutorState = { ...EMPTY }
  const checked: string[] = []
  const out: TurnTrace[] = []

  scenario.turns.forEach((turn, i) => {
    const trace: TurnTrace = { turn: i + 1, event: turn.event, rung_after: state.rung }
    if (turn.event === 'check') {
      const answer = (turn.answer ?? '').trim().slice(0, 500)
      const correct = checkPracticeAnswer(step, answer)
      checked.push(answer)
      const event: TutorEvent = { type: 'attempt', text: answer, correct }
      state = { ...state, ...applyTutorEvent(state, event, { progressed: correct }), ...pickChecks(nextChecks(state, event)), checkedAnswer: nextCheckedAnswer(state, event) }
      out.push({ ...trace, correct, rung_after: state.rung })
      return
    }
    if (turn.event === 'dont_know') {
      const event: TutorEvent = { type: 'dont_know' }
      state = { ...state, ...applyTutorEvent(state, event, {}), ...pickChecks(nextChecks(state, event)) }
      out.push({ ...trace, rung_after: state.rung })
      return
    }
    if (turn.event === 'hint') {
      const event: TutorEvent = { type: 'hint_opened', index: turn.index ?? 0 }
      if (!gateHelp(state, event).ok) {
        out.push({ ...trace, blocked: true, first_wrong_step: null })
        return
      }
      state = { ...state, ...applyTutorEvent(state, event, {}) }
      out.push({ ...trace, rung_after: state.rung })
      return
    }

    const working = (turn.working ?? '').trim()
    const message = (turn.message ?? working).trim()
    const event: TutorEvent = turn.event === 'clarify' ? { type: 'clarify' } : turn.event === 'show_worked' ? { type: 'show_worked' } : message ? { type: 'attempt', text: message } : { type: 'request' }
    const wrongAt = firstWrongStep(
      working,
      problem.steps.map((item) => ({ answer: item.correctAnswer, tolerance: item.tolerance })),
      givens
    )
    const preview = applyTutorEvent(state, event, { gapId: String(wrongAt ?? scenario.step_index) })
    const refused = (turn.event === 'show_worked' && (!gateHelp(state, event).ok || !preview.workedAllowed)) || (turn.event === 'ask' && state.checks < 1)
    if (refused) {
      out.push({ ...trace, blocked: true, first_wrong_step: wrongAt })
      return
    }
    const move = nextMove(preview, {
      event,
      lastWrong: state.lastCheckWrong,
      missKind: (turn.miss_kind ?? undefined) as never,
      justSolvedWithHints: state.checkedCorrect && preview.maxRung >= 1 && event.type === 'request',
    })
    const request = buildPracticeTutorRequest({
      problem,
      stepIndex: scenario.step_index,
      working,
      attempts: [...checked],
      hintsOpened: preview.hintsOpened,
      rung: preview.rung,
      move,
      askWhatIsUnclear: preview.askWhatIsUnclear,
      ownAnswer: state.checkedAnswer,
      firstWrong: wrongAt,
      context: { claims: [] },
      ids: { userId: 'u', projectId: 'p', sessionId: 's' },
    })
    // The ids are the server's; the eval sends none.
    const { user_id: _user, project_id: _project, session_id: _session, ...body } = request
    void [_user, _project, _session]
    state = { ...state, ...applyTutorEvent(state, event, { gapId: String(wrongAt ?? scenario.step_index) }), ...pickChecks(nextChecks(state, event)) }
    out.push({
      ...trace,
      move,
      rung_allowed: preview.rung,
      attempts: preview.attempts,
      ask_what_is_unclear: preview.askWhatIsUnclear,
      offer_worked: preview.offerWorked,
      first_wrong_step: wrongAt,
      request: body,
      rung_after: state.rung,
    })
  })
  return out
}

export function parityFixture(scenarios: Scenario[]) {
  return scenarios.map((scenario) => ({ id: scenario.id, turns: traceScenario(scenario) }))
}
