import { buildRubric, readCriteria, type RubricLine, type StoredCriterion } from '@/lib/learning/rubric'
import { parseSources, type SourceRef } from '@/lib/topics/sources'
import { reviewAnswer } from './quiz-questions'
import type { GradedQuestion } from '@/lib/ai-service/grading'

/** What is stored in quiz_attempts.results for each question index. */
export type StoredQuestionResult = {
  isCorrect: boolean
  pointsEarned: number
  pointsPossible: number
  // The grader's note, kept for short answers only; rule-graded questions have none.
  feedback?: string
  // What the grader said about each key point of a short answer, in rubric order.
  criteria?: StoredCriterion[]
  // The student pressed "I don't know": the answer is empty on purpose, which a blank is not.
  idk?: boolean
}

/** One question as shown after a quiz is graded. This is where the answer key is released. */
export type QuizReviewItem = {
  questionIndex: number
  isCorrect: boolean
  pointsEarned: number
  pointsPossible: number
  correctAnswer: string
  explanation: string
  feedback: string | null
  /** Where in the files the question is based on, for "From <file>, p. N". Empty for older quizzes. */
  sources: SourceRef[]
  /** For short answers: what the grader looked for, with a verdict per line when it gave one. */
  rubric: RubricLine[] | null
  /**
   * For a wrong multiple-choice pick: the wrong idea the picked option stands for (spec §5.7), read
   * from the option with no model call. Null when the option carries none or nothing was picked.
   */
  pickedMisconception: string | null
  /** The student pressed "I don't know" on this question, so its empty answer is not a blank one. */
  dontKnow: boolean
}

type RawQuestion = Record<string, unknown>

export function toStoredResults(graded: GradedQuestion[], dontKnow: ReadonlySet<number> = new Set()): Record<string, StoredQuestionResult> {
  const stored: Record<string, StoredQuestionResult> = {}
  for (const question of graded) {
    stored[String(question.question_index)] = {
      isCorrect: question.is_correct,
      pointsEarned: question.points_earned,
      pointsPossible: question.points_possible,
      ...(question.question_type === 'short_answer' && question.feedback
        ? { feedback: question.feedback }
        : {}),
      ...(question.question_type === 'short_answer' && question.criteria?.length ? { criteria: question.criteria } : {}),
      ...(dontKnow.has(question.question_index) ? { idk: true } : {}),
    }
  }
  return stored
}

/** Stored results come in two shapes: the current object form and older plain booleans. */
function readStoredResult(value: unknown): Partial<StoredQuestionResult> {
  if (typeof value === 'boolean') return { isCorrect: value }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      isCorrect: record.isCorrect === true,
      pointsEarned: typeof record.pointsEarned === 'number' ? record.pointsEarned : undefined,
      pointsPossible: typeof record.pointsPossible === 'number' ? record.pointsPossible : undefined,
      feedback: typeof record.feedback === 'string' ? record.feedback : undefined,
      criteria: readCriteria(record.criteria),
      idk: record.idk === true,
    }
  }
  return {}
}

/** The misconception of the option a student picked on a multiple-choice question, when it names one. */
function pickedMisconceptionOf(question: RawQuestion, answer: string | undefined): string | null {
  if (!answer || !Array.isArray(question.options)) return null
  const id = answer.trim().toUpperCase()
  const picked = question.options.find(
    (option): option is Record<string, unknown> =>
      !!option && typeof option === 'object' && String((option as Record<string, unknown>).id).trim().toUpperCase() === id
  )
  const text = typeof picked?.misconception === 'string' ? picked.misconception.replace(/\s+/g, ' ').trim() : ''
  return text || null
}

/** `answers` are the student's plain answers by question index; they say which option was picked. */
export function buildReview(questions: RawQuestion[], results: unknown, answers?: Record<string, string>): QuizReviewItem[] {
  const resultMap = results && typeof results === 'object' ? (results as Record<string, unknown>) : {}
  return questions.map((question, index) => {
    const result = readStoredResult(resultMap[String(index)])
    const points = typeof question.points === 'number' && question.points > 0 ? question.points : 1
    const isCorrect = result.isCorrect === true
    return {
      questionIndex: index,
      isCorrect,
      pointsEarned: result.pointsEarned ?? (isCorrect ? points : 0),
      pointsPossible: result.pointsPossible ?? points,
      correctAnswer: reviewAnswer(question),
      explanation: typeof question.explanation === 'string' ? question.explanation : '',
      feedback: result.feedback ?? null,
      sources: parseSources(question.sources),
      rubric: buildRubric(question, result.criteria),
      pickedMisconception: isCorrect ? null : pickedMisconceptionOf(question, answers?.[String(index)]),
      dontKnow: result.idk === true,
    }
  })
}

/** An answer as the results page has it: the plain text, or the object with its confidence. */
type AnswerWithConfidence = string | { confidence?: number }

export type ResultGroups = {
  /** Confident and wrong: the hypercorrection case, shown first. */
  sureWrong: QuizReviewItem[]
  /** Every other answer that was not fully right. */
  wrong: QuizReviewItem[]
  /** Right, but the student said they were unsure or guessing. */
  unsureRight: QuizReviewItem[]
  /** Right, and either sure or not rated. */
  solid: QuizReviewItem[]
}

/** At or above this a student counts as sure (Fairly sure stores 0.75). */
export const SURE_CONFIDENCE = 0.75

/** Results in the order of spec §5.7: sure and wrong, other wrong, right but unsure, solid. */
export function groupResults(review: QuizReviewItem[], answers: Record<string, AnswerWithConfidence>): ResultGroups {
  const groups: ResultGroups = { sureWrong: [], wrong: [], unsureRight: [], solid: [] }
  for (const item of review) {
    const given = answers[String(item.questionIndex)]
    const confidence = typeof given === 'object' && given ? given.confidence : undefined
    if (!item.isCorrect) {
      if (confidence !== undefined && confidence >= SURE_CONFIDENCE) groups.sureWrong.push(item)
      else groups.wrong.push(item)
    } else if (confidence !== undefined && confidence < SURE_CONFIDENCE) groups.unsureRight.push(item)
    else groups.solid.push(item)
  }
  return groups
}
