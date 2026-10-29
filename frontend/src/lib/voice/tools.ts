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
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { gradeAnswers, GradingRejectedError, GradingUnavailableError } from '@/lib/ai-service/grading'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule } from '@/lib/learning/mastery'
import { VoiceQuestion } from '@/lib/voice/concept'
import { buildHint, toGradableQuestion } from '@/lib/voice/grading'
import { eventsForToolOutput, type ToolOutput } from '@/lib/voice/tool-events'
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
      "Record the student's spoken answer to a question and get it graded. Returns whether it was correct and short feedback. Call it as soon as the student answers, before giving any feedback.",
    input_schema: {
      type: 'object',
      properties: {
        question_index: {
          type: 'integer',
          description: 'The index returned by get_next_question for the question being answered.',
        },
        user_answer: { type: 'string', description: "What the student said, as faithfully as possible." },
      },
      required: ['question_index', 'user_answer'],
    },
  },
  {
    name: 'get_hint',
    description: 'Get a nudge for the current question, to pass on when the student is stuck. It never contains the answer.',
    input_schema: {
      type: 'object',
      properties: {
        question_index: { type: 'integer', description: 'The index of the question the student is stuck on.' },
      },
      required: ['question_index'],
    },
  },
]

const recordAnswerArgs = z.object({
  question_index: z.number().int().nonnegative(),
  user_answer: z.string().trim().min(1).max(5000),
})

const hintArgs = z.object({
  question_index: z.number().int().nonnegative(),
})

// Each graded answer costs a model call, so one user cannot hammer them.
const answerLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 })

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

const COMPLETE: ToolOutput = { done: true, message: 'Drill complete.' }

/**
 * Runs one tool call for a session. Never throws for a problem the model can act on: bad
 * arguments, a missing question or a grading outage come back as `{ error }` in the output.
 */
export async function executeVoiceTool(
  ctx: { sessionId: string; userId: string },
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

    return finish({
      done: false,
      question_index: nextIndex,
      question: {
        question_text: nextQuestion.question_text,
        question_type: nextQuestion.question_type,
        options: nextQuestion.options || [],
        concepts_tested: nextQuestion.concepts_tested || [],
      },
    })
  }

  if (name === 'record_answer') {
    const parsed = recordAnswerArgs.safeParse(args)
    if (!parsed.success) return finish({ error: 'Invalid arguments for record_answer' })
    const { question_index: questionIndex, user_answer: userAnswer } = parsed.data
    if (session.endedAt) return finish(COMPLETE, { sessionComplete: true })

    const question = questionSet[questionIndex]
    if (!question) return finish({ error: 'Question not found' })

    const inferredTopicId =
      (typeof question.topic_id === 'string' && question.topic_id.length > 0 ? question.topic_id : null) ||
      session.topicId

    // The server grades the spoken answer; the model's own opinion of it counts for nothing.
    const gradable = toGradableQuestion(question)
    let grading: { score: number; isCorrect: boolean; comment: string; ungraded: boolean }
    if (gradable) {
      const rate = answerLimiter.check(userId)
      if (!rate.ok) {
        return finish({ error: 'Too many answers too quickly. Wait a moment and try again.' })
      }
      try {
        const graded = (await gradeAnswers([gradable], { '0': userAnswer })).graded_questions[0]
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
    const feedback = {
      comment: grading.comment,
      explanation: question.explanation || '',
      ...(grading.ungraded ? { ungraded: true } : {}),
    }
    const timing = { received_at: new Date().toISOString() }

    await prisma.voiceDrillAttempt.upsert({
      where: { sessionId_questionIndex: { sessionId, questionIndex } },
      update: { userAnswer, isCorrect: grading.isCorrect, score: grading.score, feedback, timing },
      create: {
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
    })

    // An ungraded answer is not evidence of anything, so it adds no signal.
    if (inferredTopicId && !grading.ungraded) {
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
    }

    return finish({ is_correct: grading.isCorrect, score: grading.score, feedback })
  }

  if (name === 'get_hint') {
    const parsed = hintArgs.safeParse(args)
    if (!parsed.success) return finish({ error: 'Invalid arguments for get_hint' })
    const question = questionSet[parsed.data.question_index]
    if (!question) return finish({ error: 'Question not found' })
    // A nudge built from the shape of the question. The sample answer and key points stay on
    // the server: this tool must not hand over the answer.
    return finish({ ...buildHint(question) })
  }

  return result({ error: 'Unknown tool' })
}
