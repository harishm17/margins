/**
 * "Ask about my working" on the server (spec §5.6, §6.1, §6.2): reads the step's tutor state, applies
 * the one event the submission is, picks the move, asks the AI service for the words, and saves the
 * state. A step the model could not answer leaves the state as it was, so a failed request costs no
 * rung. Using the worked example surrenders the step: it is recorded at level 3 for the closing retest.
 */

import type { OwnedTopic } from '@/server/owned'
import { prisma } from '@/lib/db/prisma'
import { checkPracticeAnswer } from '@/features/topic/practice-check'
import type { PracticeProblem, PracticeStep } from '@/features/topic/types'
import { requestPracticeTutor, type PracticeTutorRequest } from '@/lib/ai-service/tutor'
import { recordEvidence } from '@/lib/learning/evidence'
import { helpAfterMiss, type HelpAfterMiss } from '@/lib/learning/instruction-server'
import { AUTHORED_HINT_RUNG, WORKED_RUNG, buildSurrenderEvidence, practiceScopeKey } from '@/lib/learning/practice-evidence'
import { currentPractice, practiceSessionKey } from '@/lib/learning/practice-server'
import { firstWrongStep } from './first-wrong-step'
import type { PracticeTutorBody, PracticeTutorResponse, PracticeTutorState } from './practice-api'
import { loadPracticeContext, type PracticeContext } from './practice-context'
import { applyTutorEvent, gateHelp, nextMove, type TutorEvent, type TutorMove } from './state'
import { getTutorState, recordTutorEvent, type StoredTutorState } from './store'

export type PracticeTutorDeps = {
  ask: typeof requestPracticeTutor
  context: typeof loadPracticeContext
}

const defaultDeps: PracticeTutorDeps = { ask: requestPracticeTutor, context: loadPracticeContext }

export type PracticeTutorResult =
  /** There is no such problem now (the practice was rewritten): the page reloads it. */
  | { status: 'stale' }
  /** "Ask about my working" waits for a checked answer. */
  | { status: 'not_allowed' }
  /** Connect, Structure, the worked example and Show answer need one attempt on the step (spec 18.4): 409 ATTEMPT_FIRST. */
  | { status: 'attempt_first' }
  /** Too many tutor calls this minute; asked only once the request is known to be valid. */
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'ok'; body: PracticeTutorResponse }

export type Admit = () => { ok: true } | { ok: false; retryAfterSeconds: number }

const MAX_ATTEMPT_CHARS = 500

export { practiceScopeKey }

const stateOut = (state: StoredTutorState, flags: Pick<PracticeTutorState, 'workedAllowed' | 'offerWorked' | 'askWhatIsUnclear'>): PracticeTutorState => ({
  rung: state.rung,
  maxRung: state.maxRung,
  attempts: state.attempts,
  checks: state.checks,
  wrongChecks: state.wrongChecks,
  checkedCorrect: state.checkedCorrect,
  dontKnow: !!state.dontKnow,
  ...flags,
})

/**
 * What to read after a miss on this step (spec 18.3): the pointers to its concepts' first claims, the gap explainer, and an
 * easier step. It needs no model. A failure here never blocks the check that asked for it.
 */
async function helpFor(userId: string, topicId: string, step: PracticeStep): Promise<HelpAfterMiss | undefined> {
  if (step.conceptIds.length === 0) return undefined
  try {
    return await helpAfterMiss(prisma, { userId, topicId, conceptIds: step.conceptIds, surface: 'practice' })
  } catch (error) {
    console.error('Help after a miss failed:', error)
    return undefined
  }
}

/** Where the step's conversation stands, for a page that was just opened; the content row the step belongs to; and the help when it was missed. */
export async function readPracticeTutorState(
  userId: string,
  topic: OwnedTopic,
  at: { problemIndex: number; problemTitle: string; stepIndex: number }
): Promise<(PracticeTutorState & { contentId: string; help?: HelpAfterMiss }) | null> {
  const practice = await currentPractice(topic)
  const problem = practice?.problems[at.problemIndex]
  if (!practice || !problem || !problem.steps[at.stepIndex] || problem.title !== at.problemTitle) return null
  const state = await getTutorState(userId, 'practice', practiceScopeKey(practice.contentId, at.problemIndex, at.stepIndex))
  const missed = state.wrongChecks >= 1 && !state.checkedCorrect
  const help = missed ? await helpFor(userId, topic.id, problem.steps[at.stepIndex]) : undefined
  return { ...stateOut(state, { workedAllowed: state.attempts >= 1, offerWorked: false, askWhatIsUnclear: false }), contentId: practice.contentId, ...(help ? { help } : {}) }
}

/** The step as the model sees its question: a multiple-choice step lists its options. */
function questionOf(step: PracticeStep): string {
  if (step.answerType !== 'multiple_choice' || step.options.length === 0) return step.question
  return `${step.question}\n${step.options.map((option) => `${option.id}) ${option.text}`).join('\n')}`
}

/** The authored hints the student has opened, in order (the ladder opens them in order). */
export function hintsShown(step: PracticeStep, hintsOpened: number): string[] {
  return step.hints.filter((hint, index) => index < hintsOpened && hint.trim() !== '')
}

export function buildPracticeTutorRequest(input: {
  problem: PracticeProblem
  stepIndex: number
  working: string
  attempts: string[]
  hintsOpened: number
  rung: number
  move: TutorMove
  askWhatIsUnclear: boolean
  /** The answer the server graded as right when the student checked it (stored with the step's state), or null: the one a reply may confirm. */
  ownAnswer: string | null
  firstWrong: number | null
  context: PracticeContext
  ids: { userId: string; projectId: string; sessionId: string }
}): PracticeTutorRequest {
  const { problem, stepIndex, working, attempts } = input
  const step = problem.steps[stepIndex]
  return {
    problem: [problem.title, problem.problem].filter(Boolean).join('\n\n'),
    steps: problem.steps.map((item) => ({
      question: questionOf(item),
      answer: item.correctAnswer,
      acceptable_answers: item.acceptableAnswers,
      ...(item.tolerance !== null ? { tolerance: item.tolerance } : {}),
      hints: item.hints,
    })),
    step_index: stepIndex,
    working,
    attempts,
    hints_shown: hintsShown(step, input.hintsOpened),
    rung_allowed: input.rung,
    move: input.move,
    final_allowed: input.move !== 'worked_analogue' && !!input.ownAnswer,
    ...(input.move !== 'worked_analogue' && input.ownAnswer ? { own_answer: input.ownAnswer } : {}),
    ask_what_is_unclear: input.askWhatIsUnclear,
    claims: input.context.claims,
    ...(input.context.weakPrerequisite ? { weak_prerequisite: input.context.weakPrerequisite } : {}),
    ...(input.firstWrong !== null ? { first_wrong_step: input.firstWrong } : {}),
    ...(input.context.confusable ? { confusable: input.context.confusable } : {}),
    user_id: input.ids.userId,
    project_id: input.ids.projectId,
    session_id: input.ids.sessionId,
  }
}

const cleanAttempts = (attempts: string[] | undefined) =>
  (attempts ?? []).map((attempt) => attempt.trim().slice(0, MAX_ATTEMPT_CHARS)).filter(Boolean)

export async function runPracticeTutor(
  userId: string,
  topic: OwnedTopic,
  body: PracticeTutorBody,
  options: { timeZone: string; admit?: Admit },
  deps: PracticeTutorDeps = defaultDeps
): Promise<PracticeTutorResult> {
  const practice = await currentPractice(topic)
  const problem = practice?.problems[body.problemIndex]
  const step = problem?.steps[body.stepIndex]
  if (!practice || !problem || !step || problem.title !== body.problemTitle) return { status: 'stale' }

  const scopeKey = practiceScopeKey(practice.contentId, body.problemIndex, body.stepIndex)
  const attempts = cleanAttempts(body.attempts)
  const working = (body.working ?? '').trim()
  const message = (body.message ?? working).trim()

  // A checked answer or an opened hint: one event, no model call.
  if (body.event === 'check') {
    const answer = (body.answer ?? '').trim().slice(0, MAX_ATTEMPT_CHARS)
    // Nothing written is no check: it earns no rung and does not unlock the tutor's look at the working.
    if (!answer) {
      const unchanged = await getTutorState(userId, 'practice', scopeKey)
      return { status: 'ok', body: { state: stateOut(unchanged, { workedAllowed: unchanged.attempts >= 1, offerWorked: false, askWhatIsUnclear: false }), correct: false } }
    }
    const correct = checkPracticeAnswer(step, answer)
    const recorded = await recordTutorEvent(userId, 'practice', scopeKey, { type: 'attempt', text: answer, correct }, { progressed: correct })
    const help = correct ? undefined : await helpFor(userId, topic.id, step)
    return { status: 'ok', body: { state: stateOut(recorded.state, recorded), correct, ...(help ? { help } : {}) } }
  }
  if (body.event === 'dont_know') {
    const recorded = await recordTutorEvent(userId, 'practice', scopeKey, { type: 'dont_know' }, {})
    const help = await helpFor(userId, topic.id, step)
    return { status: 'ok', body: { state: stateOut(recorded.state, recorded), correct: false, ...(help ? { help } : {}) } }
  }
  if (body.event === 'hint') {
    const hintIndex = body.hintIndex ?? 0
    if (!gateHelp(await getTutorState(userId, 'practice', scopeKey), { type: 'hint_opened', index: hintIndex }).ok) return { status: 'attempt_first' }
    const recorded = await recordTutorEvent(userId, 'practice', scopeKey, { type: 'hint_opened', index: hintIndex }, {})
    return { status: 'ok', body: { state: stateOut(recorded.state, recorded) } }
  }
  if (body.event === 'reveal') {
    const current = await getTutorState(userId, 'practice', scopeKey)
    if (!gateHelp(current, { type: 'reveal' }).ok) return { status: 'attempt_first' }
    // Show answer is the same surrender as a delivered worked example (spec 18.4), flagged as a reveal. No model call.
    await recordSurrender(userId, topic, practice.contentId, body, step, options.timeZone, { reveal: true })
    const recorded = await recordTutorEvent(userId, 'practice', scopeKey, { type: 'clarify' }, { helpRung: WORKED_RUNG })
    return { status: 'ok', body: { state: stateOut(recorded.state, recorded), surrendered: true } }
  }

  // The tutor's words. The event is applied to a copy first and saved once the reply came back.
  const event: TutorEvent =
    body.event === 'clarify' ? { type: 'clarify' } : body.event === 'show_worked' ? { type: 'show_worked' } : message ? { type: 'attempt', text: message } : { type: 'request' }
  const before = await getTutorState(userId, 'practice', scopeKey)
  const wrongAt = firstWrongStep(
    working,
    problem.steps.map((item) => ({ answer: item.correctAnswer, tolerance: item.tolerance })),
    givensOf(problem)
  )
  const gapId = String(wrongAt ?? body.stepIndex)
  const preview = applyTutorEvent(before, event, { gapId })
  if (body.event === 'show_worked' && (!gateHelp(before, event).ok || !preview.workedAllowed)) return { status: 'attempt_first' }
  // Effort first (spec 5.6): the tutor looks at working once the student has checked an answer.
  if (body.event === 'ask' && before.checks < 1) return { status: 'not_allowed' }
  const admitted = options.admit?.()
  if (admitted && !admitted.ok) return { status: 'rate_limited', retryAfterSeconds: admitted.retryAfterSeconds }

  // What the checks said comes from the server's own record of them, never from the browser's list.
  const move = nextMove(preview, {
    event,
    lastWrong: before.lastCheckWrong,
    missKind: body.missKind,
    // "Check my understanding" (a request, no text) on a step solved with help: one transfer question.
    justSolvedWithHints: before.checkedCorrect && preview.maxRung >= 1 && event.type === 'request',
  })
  const context = await deps.context(userId, topic.projectId, step.conceptIds)
  const answer = await deps.ask(
    buildPracticeTutorRequest({
      problem,
      stepIndex: body.stepIndex,
      working,
      attempts,
      hintsOpened: preview.hintsOpened,
      rung: preview.rung,
      move,
      askWhatIsUnclear: preview.askWhatIsUnclear,
      ownAnswer: before.checkedAnswer,
      firstWrong: wrongAt,
      context,
      ids: { userId, projectId: topic.projectId, sessionId: scopeKey },
    })
  )

  // A worked example is a surrender only when it was delivered (spec 18.4, row 9). When the leak judge fell back to the
  // authored hint, the student got that hint and nothing more: it is recorded as the hint it is (its rung, not 5), and the
  // button stays. The surrender is the first use only, however often the example is shown again. The record comes before
  // the state, so a failed record leaves the rung where it was and a retry writes it.
  const surrendered = body.event === 'show_worked' && !answer.from_authored_hint
  if (surrendered && before.maxRung < WORKED_RUNG) await recordSurrender(userId, topic, practice.contentId, body, step, options.timeZone)
  const hintIndex = AUTHORED_HINT_RUNG.findIndex((rung) => rung === answer.rung_used)
  const applied: TutorEvent =
    body.event === 'show_worked' && answer.from_authored_hint ? (hintIndex >= 0 ? { type: 'hint_opened', index: hintIndex as 0 | 1 | 2 } : { type: 'clarify' }) : event
  // The rung of the help the reply gave (the worked example is rung 5): practice evidence reads it from the state.
  const recorded = await recordTutorEvent(userId, 'practice', scopeKey, applied, { gapId, helpRung: surrendered ? WORKED_RUNG : answer.rung_used })
  return {
    status: 'ok',
    body: {
      state: stateOut(recorded.state, recorded),
      reply: {
        text: answer.reply,
        rungUsed: answer.rung_used,
        located: answer.mistake.located,
        missKind: answer.mistake.kind ?? null,
      },
      ...(surrendered ? { surrendered } : {}),
    },
  }
}

/** Level 3, flagged: the concept is due tomorrow and the closing retest serves the item again in fresh form. */
async function recordSurrender(
  userId: string,
  topic: OwnedTopic,
  contentId: string,
  body: PracticeTutorBody,
  step: PracticeStep,
  timeZone: string,
  flags: { reveal?: boolean } = {}
) {
  const known = new Set(
    (
      await prisma.concept.findMany({
        where: { id: { in: step.conceptIds }, projectId: topic.projectId, status: 'active' },
        select: { id: true },
      })
    ).map((concept) => concept.id)
  )
  const event = buildSurrenderEvidence({
    userId,
    projectId: topic.projectId,
    topicId: topic.id,
    contentId,
    problemIndex: body.problemIndex,
    step: body.stepIndex,
    conceptIds: step.conceptIds.filter((id) => known.has(id)),
    sessionKey: practiceSessionKey(contentId, timeZone),
  })
  if (!event) return
  if (flags.reveal) event.metadata = { ...event.metadata, reveal: true }
  // Two submissions at once (a double click) take turns on the concepts' locks, and the second finds the first's record.
  await recordEvidence([event], {
    timeZone,
    userId,
    onlyIf: async (tx) =>
      !(await tx.evidenceEvent.findFirst({
        where: { userId, itemKey: event.itemKey, source: 'practice', assistance: 3, metadata: { path: ['surrendered'], equals: true } },
        select: { id: true },
      })),
  })
}

/** The numbers the problem itself states (givens): the statement and every step's question. */
export const givensOf = (problem: PracticeProblem) => [problem.title, problem.problem, ...problem.steps.map((item) => item.question)].join('\n')

