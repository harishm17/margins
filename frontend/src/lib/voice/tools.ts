import { logServerError } from '@/lib/ops/log'
import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
/**
 * The voice coach's three tools, run on the server inside the turn loop.
 *
 * The model asks for a tool, the server runs it against the session it is serving (the model
 * never names the session), and the result goes back to the model. The browser only sees the
 * events a result produces (a question card, an evaluation, a hint), so it cannot forge a
 * tool result.
 */
import { z } from 'zod'
import { promptsV2 } from '@/lib/prompt-revision'
import { asksConfidence } from '@/lib/voice/pre-run'
import { prisma } from '@/lib/db/prisma'
import { ownedTopic } from '@/server/owned'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { voiceTurnsPerMinute } from './turn-limit'
import { gradeAnswers, GradingRejectedError, GradingUnavailableError } from '@/lib/ai-service/grading'
import { dontKnowEvidence, isDontKnow } from '@/lib/learning/dont-know'
import { recordEvidence } from '@/lib/learning/evidence'
import { itemKey } from '@/lib/learning/item-key'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule } from '@/lib/learning/mastery'
import { coachStyleOf, type CoachStyle } from '@/lib/voice/coach-prompt'
import { VoiceQuestion } from '@/lib/voice/concept'
import {
  assessExplanation,
  getConceptToExplain,
  heardSince,
  NOBODY_SPOKE,
  nextClaim,
  readCoachState,
  recordCheck,
  saveState,
  type TeachToolContext,
  type TeachToolResult,
} from '@/lib/voice/teach-tools'
import { buildHint, toGradableQuestion } from '@/lib/voice/grading'
import { eventsForToolOutput, type ToolOutput } from '@/lib/voice/tool-events'
import { NO_CURRENT, type DoneResult, type ErrorResult, type HintResult, type NextQuestionResult, type RecordAnswerResult, type V2ToolName } from '@/lib/voice/tool-results'
import { conceptPageLinks } from '@/lib/voice/page-links'
import type { VoiceEvent } from '@/lib/voice/turn-client'

/** An Anthropic tool definition. */
export type VoiceToolDefinition = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export const VOICE_TOOLS: VoiceToolDefinition[] = [
  {
    name: 'get_next_question',
    description:
      'Get the next question of the drill. Returns the question text, its type, its options (for multiple choice) and its index, or says the drill is complete. Call it before asking every new question.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'record_answer',
    description:
      "Record the student's spoken answer to a question and get it graded. The app uses the words the student actually said since you asked, so call it only after they have answered. Returns whether it was correct and short feedback. Call it as soon as the student answers, before giving any feedback.",
    input_schema: {
      type: 'object',
      properties: {
        question_index: {
          type: 'integer',
          description: 'The index returned by get_next_question for the question being answered.',
        },
        confidence: {
          type: 'number',
          description:
            'How sure the student said they are, from 0 (a guess) to 1 (certain). Leave it out unless the student said it.',
        },
        idk: {
          type: 'boolean',
          description: 'True when the student said they do not know. It counts as their try, and is recorded as a wrong answer.',
        },
      },
      required: ['question_index'],
    },
  },
  {
    name: 'get_hint',
    description:
      'Get a nudge for the current question, to pass on when the student is stuck. It never contains the answer. Before the student has answered the question it returns action ask_for_try instead of a nudge: invite them to have a go first.',
    input_schema: {
      type: 'object',
      properties: {
        question_index: { type: 'integer', description: 'The index of the question the student is stuck on.' },
      },
      required: ['question_index'],
    },
  },
]

/** Teach it back: the idea to explain, the assessment of the explanation, and the check on a new example. */
export const TEACH_BACK_TOOLS: VoiceToolDefinition[] = [
  {
    name: 'get_concept_to_explain',
    description:
      "Get the idea the student should explain next: the weakest one of the topic that they have not worked through in this session. Returns its id, its name and the prompt to ask, or says every idea is done. Call it before asking the student to explain anything.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'assess_explanation',
    description:
      "Assess the student's spoken explanation of an idea against the claims from their own pages. The app uses the words the student actually said since your last question, so call it only after they have answered. Returns what they covered, got wrong or left out, and an action: probe (with the kind of question to ask), explain, ask_new_example, clarify or wrap_up. A wrap_up result also carries next_idea: what get_concept_to_explain would return now (the next idea with its concept_id and prompt, or done: true when every idea is done), so you do not call that tool after it. Call it as soon as the student has finished explaining, and again after each answer to a probe.",
    input_schema: {
      type: 'object',
      properties: {
        concept_id: { type: 'string', description: 'The concept_id returned by get_concept_to_explain.' },
      },
      required: ['concept_id'],
    },
  },
  {
    name: 'record_check',
    description:
      "Record the student's answer to the one new example or prediction you asked after assess_explanation said ask_new_example. The app uses the words the student actually said since you asked, so call it only after they have answered. Returns whether it held and what to do next; when that is wrap_up, next_idea is the next idea to ask (or done: true when every idea is done), as after assess_explanation.",
    input_schema: {
      type: 'object',
      properties: {
        concept_id: { type: 'string', description: 'The concept_id of the idea being explained.' },
        question: { type: 'string', description: 'The example or prediction question you asked, in the words you used.' },
      },
      required: ['concept_id', 'question'],
    },
  },
]

/** Guided reading: the next claim of the student's pages, first to predict and then to read, and a check on it. */
export const GUIDED_READING_TOOLS: VoiceToolDefinition[] = [
  {
    name: 'next_claim',
    description:
      'Move through the claims of the student\'s pages. With no arguments it gives the next claim\'s idea and a prediction prompt, without the claim, so the student can predict first. With reveal true and your check_question, it returns the claim and its page to tell, but only after the student has said their prediction: the app uses what they said since you asked. Also use it with no arguments to move on or skip.',
    input_schema: {
      type: 'object',
      properties: {
        reveal: { type: 'boolean', description: 'True to get the claim after the student has predicted.' },
        check_question: { type: 'string', description: 'The question you will ask once you have told the claim. Required with reveal.' },
      },
      required: [],
    },
  },
  {
    name: 'record_check',
    description:
      "Record the student's answer to your check question about the claim you just told. The app uses the words the student actually said since you asked, so call it only after they have answered. Returns whether it was right and what to say.",
    input_schema: {
      type: 'object',
      properties: {
        claim_index: { type: 'integer', description: 'The claim_index returned by next_claim.' },
        idk: { type: 'boolean', description: 'True when the student said they do not know. The check is recorded as missed, and you restate the claim.' },
      },
      required: ['claim_index'],
    },
  },
]

/**
 * Prompt audit 2026-11-09 (H3, R5, R6): the v2 tools. Each description is written from the tool's typed result
 * (tool-results.ts) and names every top-level key it can return, errors included; tool-contract.test.ts checks that.
 * The model is no longer asked for values the server holds: `question_index`, `concept_id` and `claim_index` come from the
 * coach state (the question last returned by get_next_question, the concept last returned by get_concept_to_explain,
 * the claim last returned by next_claim). The two `record_check` tools get names of their own.
 * `get_next_question` is described with the two flags that `quizQuestionFlags` adds to its result (H2).
 */
const V2_DESCRIPTIONS: Record<V2ToolName, string> = {
  get_next_question:
    'Get the next question of the drill. Returns done: false with question_index and question (question_text, question_type, options for multiple choice, concepts_tested), plus ask_confidence_first and ask_why_if_right; or done: true with a message when the drill is complete. Returns an error when the session cannot be found. Call it before asking every new question.',
  record_answer:
    "Record the student's spoken answer to the question you last got from get_next_question and get it graded. The app uses the words the student said since the question was asked, so call it only after they have answered; it returns an error otherwise. Returns is_correct, score (0 to 1), feedback (comment, explanation, and ungraded when the question has no answer key) and, for a wrong answer, where_to_look (pages for the idea). Returns an error if grading is unavailable, or error no_current_question when you have not got a question yet (call get_next_question), or done: true with a message when the drill is over.",
  get_hint:
    'Get a nudge for the question you last got from get_next_question, to pass on when the student is stuck. It never contains the answer. Returns hint, concepts (the ideas the question tests), a note and, when the answer has several ideas, ideas_expected. Before the student has answered the question it returns action ask_for_try with an instruction instead of a nudge: invite them to have a go first. Returns error no_current_question when you have not got a question yet.',
  get_concept_to_explain:
    "Get the idea the student should explain next: the weakest one of the topic that they have not worked through in this session. Returns done: false with concept_id, concept_name, the prompt to ask and ideas_left, or done: true with a message when every idea is done, or an error. Call it before asking the student to explain anything.",
  assess_explanation:
    "Assess the student's spoken explanation of the idea you last got from get_concept_to_explain against the claims from their own pages. The app uses the words the student said since your last question, so call it only after they have answered; it returns an error otherwise (error no_current_concept when you have not got an idea yet). Returns concept, and what they covered, partly covered (partly), got wrong (incorrect) or left out (missing), and an action: probe (with probe.type and the gap to ask about), explain or explain_first (with source_claim and its page), ask_new_example (with an instruction), clarify (with a clarifying_question) or wrap_up (with an outcome, look_again when pages need another look, and next_idea: what get_concept_to_explain would return now, so you do not call it after a wrap_up). Returns done: true with a message when the session is over. Call it when the student has finished explaining, and again after each answer to a probe.",
  record_example_check:
    "Record the student's answer to the one new example or prediction you asked after assess_explanation said ask_new_example, for the idea you last got from get_concept_to_explain. The app uses the words the student said since you asked, so call it only after they have answered. Returns concept and passed (whether it held), what they covered, partly covered (partly), got wrong (incorrect) or left out (missing), and the next action as assess_explanation does (probe, explain or explain_first with source_claim, ask_new_example, clarify with a clarifying_question, or wrap_up with an outcome, look_again, next_idea and an instruction). Returns an error (no_current_concept when you have not got an idea yet, or when the student has not spoken), or done: true with a message when the session is over.",
  next_claim:
    "Move through the claims of the student's pages. With no arguments it gives the next claim's idea and a prediction prompt, without the claim, so the student can predict first. Returns done: false with claim_index, of (the number of claims), concept_name, prediction_prompt and an instruction. With reveal true and your check_question, it returns the claim (its text and page) with an instruction, but only after the student has said their prediction: the app uses what they said since you asked. Also use it with no arguments to move on or skip. Returns done: true with a message when every claim has been read, or an error.",
  record_claim_check:
    "Record the student's answer to your check question about the claim you just told (the one next_claim last returned). The app uses the words the student said since you asked, so call it only after they have answered. Returns verdict (right, partly right, not right or not yet), you_said when there are student words to quote, wrong_idea (the grader's own description of the mistake, not a quotation) when it found one, the claim (its text and page), claims_left and an instruction. When the answer was too short or unclear it returns action clarify with a clarifying_question and an instruction. Returns an error (no_current_claim when you have not told a claim yet), or done: true with a message when the session is over.",
}

/** The v2 list of a style: the audited descriptions, the schemas without the values the server holds, the checks renamed. */
function v2Tools(style: CoachStyle, tools: VoiceToolDefinition[]): VoiceToolDefinition[] {
  const without = (tool: VoiceToolDefinition, ...names: string[]): VoiceToolDefinition['input_schema'] => ({
    ...tool.input_schema,
    properties: Object.fromEntries(Object.entries(tool.input_schema.properties).filter(([key]) => !names.includes(key))),
    required: tool.input_schema.required.filter((key) => !names.includes(key)),
  })
  return tools.map((tool): VoiceToolDefinition => {
    switch (tool.name) {
      case 'record_answer':
        return { ...tool, description: V2_DESCRIPTIONS.record_answer, input_schema: without(tool, 'question_index') }
      case 'get_hint':
        return { ...tool, description: V2_DESCRIPTIONS.get_hint, input_schema: without(tool, 'question_index') }
      case 'assess_explanation':
        return { ...tool, description: V2_DESCRIPTIONS.assess_explanation, input_schema: without(tool, 'concept_id') }
      case 'record_check':
        return style === 'guided_reading'
          ? { ...tool, name: 'record_claim_check', description: V2_DESCRIPTIONS.record_claim_check, input_schema: without(tool, 'claim_index') }
          : { ...tool, name: 'record_example_check', description: V2_DESCRIPTIONS.record_example_check, input_schema: without(tool, 'concept_id') }
      default:
        return tool.name in V2_DESCRIPTIONS ? { ...tool, description: V2_DESCRIPTIONS[tool.name as V2ToolName] } : tool
    }
  })
}

/**
 * The tools the coach gets in a style. A topic conversation gets none. With `v2` (PROMPTS_V2, area "voice") the
 * descriptions are the audited ones; without it the result is the v1 list, unchanged.
 */
export function toolsForStyle(style: CoachStyle, v2: boolean = promptsV2('voice')): VoiceToolDefinition[] {
  const tools = ((): VoiceToolDefinition[] => {
    switch (style) {
      case 'oral_quiz':
        return VOICE_TOOLS
      case 'teach_back':
        return TEACH_BACK_TOOLS
      case 'guided_reading':
        return GUIDED_READING_TOOLS
      case 'topic_conversation':
        return []
    }
  })()
  return v2 ? v2Tools(style, tools) : tools
}

/** The two quiz steps that depend on a question's place in the drill, decided here so the model does not compute them (H2). */
export function quizQuestionFlags(questionIndex: number): { ask_confidence_first: boolean; ask_why_if_right: boolean } {
  return { ask_confidence_first: asksConfidence(questionIndex), ask_why_if_right: questionIndex % 2 === 1 }
}

const TEACH_TOOL_NAMES = new Set(['get_concept_to_explain', 'assess_explanation', 'next_claim', 'record_check', 'record_example_check', 'record_claim_check'])

const assessArgs = z.object({
  concept_id: z.string().min(1).max(100),
})

const nextClaimArgs = z.object({
  reveal: z.boolean().optional(),
  check_question: z.string().max(2000).optional(),
})

const recordAnswerArgs = z.object({
  question_index: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  idk: z.boolean().optional(),
})

const hintArgs = z.object({
  question_index: z.number().int().nonnegative(),
})

// v2 (R5): the question is the one the server last gave, so the model passes only what the server cannot know.
const recordAnswerArgsV2 = recordAnswerArgs.omit({ question_index: true })

// Each graded answer costs a model call, so one user cannot hammer them.
const answerLimiter = createRateLimiter({ name: 'voice-grade', limit: voiceTurnsPerMinute(), windowMs: 60_000 })

export type VoiceToolResult = {
  /** What goes back to the model as the tool result. */
  output: ToolOutput
  /** What the browser is told. */
  events: VoiceEvent[]
  /** The drill is over (the session has been marked ended). */
  sessionComplete: boolean
  /** The tool failed in a way the model should know about (an unknown tool, bad arguments, an error). */
  isError: boolean
}

function result(output: ToolOutput, events: VoiceEvent[] = [], extra: Partial<VoiceToolResult> = {}): VoiceToolResult {
  return { output, events, sessionComplete: false, isError: 'error' in output, ...extra }
}

const COMPLETE: ToolOutput = { done: true, message: 'Drill complete.' } satisfies DoneResult

/**
 * Writes one graded spoken answer as evidence (spec §5.8, §18.4): level 0, or level 1 with score 0 after a hint, source
 * voice, the session key being the drill session. The question's concept ids must still be active
 * concepts of the project; a question with none (a drill from before the concept graph) writes
 * nothing. A failure is logged and never takes the recorded answer away.
 */
async function recordVoiceEvidence(input: {
  userId: string
  projectId: string
  topicId: string
  sessionId: string
  questionIndex: number
  question: VoiceQuestion
  score: number
  confidence?: number
  hinted: boolean
  /** The student said they do not know (the app's own detector, or the coach's flag): recorded as a wrong answer, no confidence. */
  idk?: boolean
  timeZone: string
}): Promise<void> {
  try {
    const wanted = [...new Set((input.question.concept_ids ?? []).filter((id) => typeof id === 'string' && id))]
    if (wanted.length === 0) return
    const known = new Set(
      (
        await prisma.concept.findMany({
          where: { id: { in: wanted }, projectId: input.projectId, status: 'active' },
          select: { id: true },
        })
      ).map((concept) => concept.id)
    )
    const conceptIds = wanted.filter((id) => known.has(id))
    if (conceptIds.length === 0) return
    const base = {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      itemKey: itemKey({ kind: 'voice', sessionId: input.sessionId, index: input.questionIndex }),
      conceptIds,
      sessionKey: `voice:${input.sessionId}`,
      metadata: { questionIndex: input.questionIndex },
    }
    await recordEvidence(
      input.idk
        ? // An "I don't know" is a wrong answer with no confidence: level 0, or level 1 when a hint came first (spec 18.3).
          dontKnowEvidence({ ...base, surface: 'voice', level: input.hinted ? 1 : 0 })
        : [
            {
              ...base,
              source: 'voice',
              // A hint before the first answer made it a failed first try (spec 18.4): level 1, score 0.
              score: input.hinted ? 0 : input.score,
              assistance: input.hinted ? 1 : 0,
              confidence: input.confidence,
              gradedBy: 'model',
            },
          ],
      { timeZone: input.timeZone, userId: input.userId, skipIfPresent: true }
    )
  } catch (error) {
    logServerError('Recording voice evidence failed', error)
  }
}

/**
 * Runs one tool call for a session. Never throws for a problem the model can act on: bad
 * arguments, a missing question or a grading outage come back as `{ error }` in the output.
 */
async function runVoiceTool(
  ctx: {
    sessionId: string
    userId: string
    /** The student's IANA zone, for the one-review-per-local-day rule; UTC when absent. */
    timeZone?: string
    /** Replaces the recall grader of the AI service (tests). */
    grade?: TeachToolContext['grade']
    /** The student turn this call belongs to (`beginVoiceTurn`): what they said is looked up by it, never taken from the model. */
    turn: number
    /** The step runs before the model speaks (spec 19.1): a guided-reading reveal gets the server's own check question. */
    autoCheck?: boolean
    /**
     * Takes work the coach's reply does not wait for (a recorded answer's signal, mastery, schedule and evidence), so the
     * feedback starts sooner. The caller must wait for it before the turn ends. Without it the work is done before the
     * tool returns.
     */
    defer?: (work: Promise<void>) => void
  },
  name: string,
  args: unknown
): Promise<VoiceToolResult> {
  const { sessionId, userId } = ctx
  const session = await prisma.voiceDrillSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return result({ error: 'Session not found' })

  const questionSet = Array.isArray(session.questionSet) ? (session.questionSet as VoiceQuestion[]) : []
  const total = questionSet.length
  const finish = (output: ToolOutput, extra: Partial<VoiceToolResult> = {}) =>
    result(output, eventsForToolOutput(name, output, total), extra)

  const v2 = promptsV2('voice')
  if (TEACH_TOOL_NAMES.has(name)) {
    const style = coachStyleOf(session.style)
    // v2 names the two checks apart; the pre-run step and an older client still say record_check, which means the style's own.
    if (v2 && name === 'record_check') name = style === 'guided_reading' ? 'record_claim_check' : 'record_example_check'
    if (!toolsForStyle(style).some((tool) => tool.name === name)) return result({ error: 'Unknown tool' })
    if (session.endedAt) return result(COMPLETE, [{ type: 'session_complete' }], { sessionComplete: true })
    const teachCtx: TeachToolContext = {
      sessionId,
      userId,
      projectId: session.projectId,
      topic: session.topicId ? await ownedTopic(userId, session.topicId, session.projectId) : null,
      timeZone: ctx.timeZone ?? 'UTC',
      grade: ctx.grade,
      allowGrading: async () => (await answerLimiter.check(userId)).ok,
      turn: ctx.turn,
      autoCheck: ctx.autoCheck,
    }
    const state = readCoachState(session.coachState)
    let done: TeachToolResult
    if (name === 'get_concept_to_explain') {
      done = await getConceptToExplain(teachCtx, state)
    } else if (name === 'assess_explanation') {
      // v2 (R5): the concept is the one get_concept_to_explain last returned.
      if (v2) {
        if (!state.teach.current) return result({ error: NO_CURRENT.concept } satisfies ErrorResult)
        done = await assessExplanation(teachCtx, state, { concept_id: state.teach.current })
        return result(done.output, done.events, { sessionComplete: done.sessionComplete === true })
      }
      const parsed = assessArgs.safeParse(args)
      if (!parsed.success) return result({ error: 'Invalid arguments for assess_explanation' })
      done = await assessExplanation(teachCtx, state, parsed.data)
    } else if (name === 'next_claim') {
      const parsed = nextClaimArgs.safeParse(args ?? {})
      if (!parsed.success) return result({ error: 'Invalid arguments for next_claim' })
      done = await nextClaim(teachCtx, state, parsed.data)
    } else {
      let input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      if (v2) {
        // v2 (R5): the concept or claim is the one the server last gave; whatever the model passes for it is ignored.
        if (style === 'guided_reading') {
          if (state.guided.stage === 'idle') return result({ error: NO_CURRENT.claim } satisfies ErrorResult)
          input = { ...input, claim_index: state.guided.index }
        } else {
          if (!state.teach.current) return result({ error: NO_CURRENT.concept } satisfies ErrorResult)
          input = { ...input, concept_id: state.teach.current }
        }
      }
      done = await recordCheck(teachCtx, state, style === 'guided_reading' ? 'guided_reading' : 'teach_back', input)
    }
    return result(done.output, done.events, { sessionComplete: done.sessionComplete === true })
  }

  if (name === 'get_next_question') {
    if (session.endedAt) return finish(COMPLETE, { sessionComplete: true })

    const attempts = await prisma.voiceDrillAttempt.findMany({
      where: { sessionId },
      select: { questionIndex: true },
    })
    const attempted = new Set(attempts.map((a) => a.questionIndex))
    let nextIndex = 0
    while (attempted.has(nextIndex) && nextIndex < questionSet.length) nextIndex += 1
    const nextQuestion = questionSet[nextIndex]

    if (!nextQuestion) {
      await prisma.voiceDrillSession.update({
        where: { id: sessionId },
        data: { endedAt: new Date(), status: 'ended' },
      })
      return finish(COMPLETE, { sessionComplete: true })
    }

    // The answer to this question is whatever the student says after this turn.
    const quizState = readCoachState(session.coachState)
    quizState.quiz.askedTurn = ctx.turn
    quizState.quiz.current = nextIndex
    await saveState(sessionId, quizState)

    return finish({
      done: false,
      question_index: nextIndex,
      question: {
        question_text: nextQuestion.question_text,
        question_type: nextQuestion.question_type,
        options: nextQuestion.options || [],
        concepts_tested: nextQuestion.concepts_tested || [],
      },
      ...(promptsV2('voice') ? quizQuestionFlags(nextIndex) : {}),
    } satisfies NextQuestionResult)
  }

  if (name === 'record_answer') {
    const parsed = v2 ? recordAnswerArgsV2.safeParse(args ?? {}) : recordAnswerArgs.safeParse(args)
    if (!parsed.success) return finish({ error: 'Invalid arguments for record_answer' } satisfies ErrorResult)
    const quizState = readCoachState(session.coachState)
    if (session.endedAt) return finish(COMPLETE, { sessionComplete: true })
    // The question is the one get_next_question last returned (v2, R5: the model passes no index). The earlier prompts
    // still ask the model for the index, and it is not trusted either: a model that miscounted had the answer graded
    // against another question's key. Only a session from before the server kept the current question uses it.
    if (v2 && quizState.quiz.current < 0) return finish({ error: NO_CURRENT.question } satisfies ErrorResult)
    const questionIndex =
      quizState.quiz.current >= 0 ? quizState.quiz.current : (parsed.data as z.infer<typeof recordAnswerArgs>).question_index
    const { confidence } = parsed.data

    const question = questionSet[questionIndex]
    if (!question) return finish({ error: 'Question not found' } satisfies ErrorResult)

    // The answer is what the student said since the question (or the last hint) was put to them, as the server heard it.
    // Nothing said, nothing recorded: an answer cannot be made up, or taken in the turn that asked the question.
    const userAnswer = heardSince(quizState, quizState.quiz.askedTurn)
    if (!userAnswer) return finish({ error: NOBODY_SPOKE })

    // The topic this answer is written to (attempt, signal, review schedule, evidence) is the question's own topic, or
    // the session's, and only when it is the student's and in this course: a question set is stored data, never trusted
    // for a write (SEC-L1).
    const claimedTopicId =
      (typeof question.topic_id === 'string' && question.topic_id.length > 0 ? question.topic_id : null) ||
      session.topicId
    const questionTopic = claimedTopicId ? await ownedTopic(userId, claimedTopicId, session.projectId) : null
    const inferredTopicId = questionTopic?.id ?? null

    // "I don't know" has one detector (lib/learning/dont-know.ts), applied to what the student said as well as to the coach's flag.
    const dontKnow = parsed.data.idk === true || isDontKnow(userAnswer)

    // The server grades the spoken answer; the model's own opinion of it counts for nothing.
    const gradable = toGradableQuestion(question)
    let grading: { score: number; isCorrect: boolean; comment: string; ungraded: boolean }
    if (dontKnow) {
      // Nothing was answered, so nothing is graded: a wrong answer with score 0 (spec 18.3).
      grading = { score: 0, isCorrect: false, comment: 'The student said they did not know.', ungraded: false }
    } else if (gradable) {
      const rate = await answerLimiter.check(userId)
      if (!rate.ok) {
        return finish({ error: 'Too many answers too quickly. Wait a moment and try again.' })
      }
      try {
        const graded = (await gradeAnswers({ userId, projectId: session.projectId }, [gradable], { '0': userAnswer })).graded_questions[0]
        grading = {
          score: graded.points_possible > 0 ? graded.points_earned / graded.points_possible : 0,
          isCorrect: graded.is_correct,
          comment: graded.feedback,
          ungraded: false,
        }
      } catch (gradeError) {
        if (gradeError instanceof GradingUnavailableError || gradeError instanceof GradingRejectedError) {
          // Nothing is stored: a failed grading call must not become a score.
          return finish({
            error: 'Grading is unavailable right now. Do not give a score. Tell the student and offer to try again.',
          })
        }
        throw gradeError
      }
    } else {
      // No sample answer or key points to grade against: record it, but as ungraded.
      grading = {
        score: 0,
        isCorrect: false,
        comment: 'This question has no answer key, so it was not graded.',
        ungraded: true,
      }
    }
    // Those words are used up: a second record_answer needs new ones.
    quizState.quiz.askedTurn = ctx.turn
    await saveState(sessionId, quizState)
    const feedback = {
      comment: grading.comment,
      explanation: question.explanation || '',
      ...(grading.ungraded ? { ungraded: true } : {}),
    }
    const timing = { received_at: new Date().toISOString() }

    // Only the first answer to a question is a retrieval: a second one follows the coach's feedback. The
    // insert is the claim (unique on session and question), so two answers arriving together cannot both
    // be first.
    const created = await prisma.voiceDrillAttempt.createMany({
      data: [
        {
          sessionId,
          userId,
          topicId: inferredTopicId,
          questionIndex,
          questionType: question.question_type,
          questionText: question.question_text,
          expectedAnswer: {
            key_points: question.key_points || [],
            sample_answer: question.sample_answer || '',
          },
          userAnswer,
          isCorrect: grading.isCorrect,
          score: grading.score,
          feedback,
          timing,
        },
      ],
      skipDuplicates: true,
    })
    const firstAnswer = created.count === 1
    if (!firstAnswer) {
      await prisma.voiceDrillAttempt.update({
        where: { sessionId_questionIndex: { sessionId, questionIndex } },
        data: { userAnswer, isCorrect: grading.isCorrect, score: grading.score, feedback, timing },
      })
    }

    // An ungraded answer is not evidence of anything, so it adds no signal.
    if (inferredTopicId && !grading.ungraded) {
      const bookkeeping = async () => {
        await recordLearningSignal({
          userId,
          projectId: session.projectId,
          topicId: inferredTopicId,
          source: 'voice',
          score: grading.score,
          metadata: { sessionId, questionIndex },
        })
        await applyPendingQuizResults(userId)
        const mastery = await computeTopicMastery(userId, session.projectId, inferredTopicId)
        await upsertReviewSchedule({
          userId,
          projectId: session.projectId,
          topicId: inferredTopicId,
          mastery: mastery.mastery,
          wasCorrect: grading.isCorrect,
        })
        // After the schedule above, so the concept-derived due date is the one that stays. Asked for on every answer,
        // not only the one whose insert was first: the evidence writer keeps one event per question (skipIfPresent), so
        // a second answer adds nothing, and an answer whose first try failed after the insert (bug: the evidence was
        // then never written) gets its evidence when it is recorded again.
        await recordVoiceEvidence({
          userId,
          projectId: session.projectId,
          topicId: inferredTopicId,
          sessionId,
          questionIndex,
          question,
          score: grading.score,
          confidence: dontKnow ? undefined : confidence,
          // A hint came before the answer: it was a failed first try (spec 18.4, level 1).
          hinted: session.hintedQuestions.includes(questionIndex),
          idk: dontKnow,
          timeZone: ctx.timeZone ?? 'UTC',
        })
      }
      // The coach's feedback needs none of this, so a caller that will wait for it (the turn route) takes it and the
      // reply starts while it runs. A failure there is logged: the answer itself is stored.
      if (ctx.defer) {
        ctx.defer(bookkeeping().catch((error) => logServerError('Voice: recording what a spoken answer showed failed', error, { sessionId, questionIndex })))
      } else {
        await bookkeeping()
      }
    }

    const recorded = { is_correct: grading.isCorrect, score: grading.score, feedback }
    // A wrong answer comes back with the pages of the question's concepts, for the summary's list of what to revisit.
    const lookLinks = !grading.isCorrect && !grading.ungraded ? await conceptPageLinks(session.projectId, question.concept_ids ?? []) : []
    const events = eventsForToolOutput(name, recorded, total).map((event) => (event.type === 'evaluation' && lookLinks.length > 0 ? { ...event, lookLinks } : event))
    // The coach names where the idea is in the student's pages (the oral quiz never reveals the answer); the links go to the browser.
    return result((lookLinks.length > 0 ? { ...recorded, where_to_look: lookLinks.map((link) => link.label) } : recorded) satisfies RecordAnswerResult, events)
  }

  if (name === 'get_hint') {
    // v2 (R5): the question is the one get_next_question last returned; the model passes nothing.
    let hintIndex: number
    if (v2) {
      hintIndex = readCoachState(session.coachState).quiz.current
      if (hintIndex < 0) return finish({ error: NO_CURRENT.question } satisfies ErrorResult)
    } else {
      const parsed = hintArgs.safeParse(args)
      if (!parsed.success) return finish({ error: 'Invalid arguments for get_hint' })
      // As in record_answer: the question being asked is the server's to say, when it has kept it.
      const current = readCoachState(session.coachState).quiz.current
      hintIndex = current >= 0 ? current : parsed.data.question_index
    }
    const question = questionSet[hintIndex]
    if (!question) return finish({ error: 'Question not found' })
    // A try comes before a hint (spec 18.4): until the student has answered this question, the coach is told to ask for a go.
    // Nothing is recorded, so the question is still open for a first try.
    const tried = await prisma.voiceDrillAttempt.count({ where: { sessionId, questionIndex: hintIndex } })
    if (tried === 0 && !session.hintedQuestions.includes(hintIndex)) {
      return finish({ action: 'ask_for_try', instruction: 'The student has not answered yet. Invite them to have a go first, in a few words, and give no nudge. Saying they do not know counts as a go.' } satisfies HintResult)
    }
    if (!session.hintedQuestions.includes(hintIndex)) {
      await prisma.voiceDrillSession.update({
        where: { id: sessionId },
        data: { hintedQuestions: { push: hintIndex } },
      })
    }
    // After a hint the student answers again, in words said after this turn.
    const hintState = readCoachState(session.coachState)
    hintState.quiz.askedTurn = ctx.turn
    await saveState(sessionId, hintState)
    // A nudge built from the shape of the question. The sample answer and key points stay on
    // the server: this tool must not hand over the answer.
    return finish({ ...buildHint(question) } satisfies HintResult)
  }

  return result({ error: 'Unknown tool' })
}

/**
 * The results of the graded steps already run for one student utterance (spec 19.1), kept for the length of the turn.
 * The server runs the step the session is waiting for before the model speaks and gives the model the result; if the model
 * asks for the same step anyway, it gets the stored result and nothing is graded or recorded a second time. Only a
 * result that worked is kept: a step that failed may be asked for again, as before.
 */
export type StepCache = Map<string, VoiceToolResult>

/** The key of a step: the tool and what it is about. Null for a tool that is not a graded step. */
export function stepKey(name: string, args: unknown, v2: boolean = promptsV2('voice')): string | null {
  // v2: the model passes no index or id (they come from the session), so a step is keyed by its tool alone; the pre-run step
  // says record_check and the model says record_example_check or record_claim_check, and they are the same step.
  if (v2) {
    switch (name) {
      case 'record_answer':
      case 'assess_explanation':
        return name
      case 'next_claim':
        return (args as { reveal?: unknown } | null)?.reveal === true ? 'next_claim:reveal' : null
      case 'record_check':
      case 'record_example_check':
      case 'record_claim_check':
        return 'record_check'
      default:
        return null
    }
  }
  const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  switch (name) {
    case 'record_answer':
      return `record_answer:${String(input.question_index)}`
    case 'assess_explanation':
      return `assess_explanation:${String(input.concept_id)}`
    case 'next_claim':
      return input.reveal === true ? 'next_claim:reveal' : null
    case 'record_check':
      return `record_check:${String(input.concept_id ?? input.claim_index)}`
    default:
      return null
  }
}

/** Runs one tool call for a session, returning the stored result when this turn already ran the step. */
export async function executeVoiceTool(
  ctx: Parameters<typeof runVoiceTool>[0] & { steps?: StepCache },
  name: string,
  args: unknown
): Promise<VoiceToolResult> {
  const key = ctx.steps ? stepKey(name, args) : null
  const stored = key ? ctx.steps?.get(key) : undefined
  // Its events went to the browser when the step ran.
  if (stored) return { ...stored, events: [] }
  const done = await runVoiceTool(ctx, name, args)
  if (key && !done.isError) ctx.steps?.set(key, done)
  return done
}
