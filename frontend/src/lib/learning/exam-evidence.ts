import { logServerError } from '@/lib/ops/log'
import { prisma } from '@/lib/db/prisma'
import type { GradedQuestion } from '@/lib/ai-service/grading'
import { confidenceOf, plainAnswerOf } from '@/lib/exams/attempt-timing'
import type { ItemAnswerInput } from './evidence-types'
import { recordEvidence } from './evidence'
import { itemKey } from './item-key'
import { buildGradedEvidence } from './quiz-evidence'
import type { QuizAnswer } from './quiz-answers'

type RawQuestion = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The session key of one exam submission: a regrade replaces every event written under it. */
export const examSessionKey = (submissionId: string) => `exam:${submissionId}`

/** The stored exam answers (plain values or `{ answer, confidence }`) as text answers with their confidence. */
export function examAnswers(stored: unknown): Record<string, QuizAnswer> {
  const out: Record<string, QuizAnswer> = {}
  if (!isRecord(stored)) return out
  for (const [key, value] of Object.entries(stored)) {
    const plain = plainAnswerOf(value)
    if (plain === undefined || plain === null) continue
    const entry: QuizAnswer = { answer: String(plain) }
    const confidence = confidenceOf(value)
    if (confidence !== undefined) entry.confidence = confidence
    out[key] = entry
  }
  return out
}

/** The graded questions the grading job stored on the submission. */
export function gradedQuestionsOf(aiGrading: unknown): GradedQuestion[] {
  if (!isRecord(aiGrading) || !Array.isArray(aiGrading.graded_questions)) return []
  return aiGrading.graded_questions.filter(isRecord) as unknown as GradedQuestion[]
}

/**
 * One piece of evidence per answered, graded exam question that names concepts (spec §5.9): level 0,
 * source exam, the session key being the submission. A question the grader could not grade
 * (`needs_review`) is not evidence yet. Short answers are model-graded, so they carry the model weight.
 */
export function buildExamEvidence(input: {
  userId: string
  projectId: string
  examId: string
  submissionId: string
  questions: RawQuestion[]
  answers: unknown
  aiGrading: unknown
  /** Concept ids that exist and are active; anything else on a question is ignored. */
  knownConceptIds?: Set<string>
  /** Topic ids that still exist; a question of a deleted topic is filed under none. */
  knownTopicIds?: Set<string>
  at?: Date
}): ItemAnswerInput[] {
  const topicOf = (index: number) => {
    const topicId = input.questions[index]?.topic_id
    return typeof topicId === 'string' && topicId && (!input.knownTopicIds || input.knownTopicIds.has(topicId)) ? topicId : null
  }
  return buildGradedEvidence(
    {
      userId: input.userId,
      projectId: input.projectId,
      source: 'exam',
      sessionKey: examSessionKey(input.submissionId),
      itemKeyOf: (index) => itemKey({ kind: 'exam', examId: input.examId, index }),
      topicOf,
    },
    {
      questions: input.questions,
      answers: examAnswers(input.answers),
      graded: gradedQuestionsOf(input.aiGrading).filter((graded) => !graded.needs_review),
      knownConceptIds: input.knownConceptIds,
      at: input.at,
    }
  )
}

/**
 * Writes a graded exam as evidence, replacing whatever the submission wrote before, so a regrade
 * leaves the events of the latest grading only. A failure is logged and never takes the result away;
 * it returns false so the caller leaves the submission marked as owing its evidence.
 */
export async function recordExamEvidence(
  input: Omit<Parameters<typeof buildExamEvidence>[0], 'knownConceptIds' | 'knownTopicIds'> & { timeZone: string }
): Promise<boolean> {
  try {
    const wanted = [
      ...new Set(
        input.questions.flatMap((q) => (Array.isArray(q.concept_ids) ? q.concept_ids : [])).filter((id): id is string => typeof id === 'string')
      ),
    ]
    const topicIds = [...new Set(input.questions.map((q) => q.topic_id).filter((id): id is string => typeof id === 'string' && !!id))]
    const [concepts, topics] = await Promise.all([
      wanted.length
        ? prisma.concept.findMany({ where: { id: { in: wanted }, projectId: input.projectId, status: 'active' }, select: { id: true } })
        : [],
      topicIds.length ? prisma.topic.findMany({ where: { id: { in: topicIds }, projectId: input.projectId }, select: { id: true } }) : [],
    ])
    const inputs = buildExamEvidence({
      ...input,
      knownConceptIds: new Set(concepts.map((c) => c.id)),
      knownTopicIds: new Set(topics.map((t) => t.id)),
    })
    // Nothing to write now may still have something to remove: a regrade that no longer counts a question.
    await recordEvidence(inputs, {
      timeZone: input.timeZone,
      userId: input.userId,
      replaceSessionKeys: [examSessionKey(input.submissionId)],
    })
    return true
  } catch (error) {
    logServerError('Recording exam evidence failed', error)
    return false
  }
}
