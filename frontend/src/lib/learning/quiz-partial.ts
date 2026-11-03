/**
 * The rule-graded part of a quiz whose short answers wait for the AI (spec 18.9). Pure, so the server and the browser
 * read it the same way. The server side (grading, storing, writing evidence) is `gradeRuleItemsNow` in quiz-submissions.ts.
 */

import type { GradedQuestion } from '@/lib/ai-service/grading'
import type { QuizReviewItem } from './quiz-review'

/** How the rule-graded part reads: right out of all, and how many short answers still wait. */
export type PartialSummary = { correct: number; total: number; waiting: number }

export type PartialQuiz = {
  summary: PartialSummary
  /** The rule-gradable questions' results, with their answer keys (they are graded). */
  review: QuizReviewItem[]
  /** The student's plain answers, for the review list. */
  answers: Record<string, string>
}

export function partialSummary(ruleGraded: GradedQuestion[], waiting: number): PartialSummary {
  return { correct: ruleGraded.filter((q) => q.is_correct).length, total: ruleGraded.length, waiting }
}

/** The line the partial view starts with (copy draft, spec 18.9, Q9): what is graded and what waits, no overall score. */
export function partialLine({ correct, total, waiting }: PartialSummary): string {
  const short = waiting === 1 ? '1 short answer waits' : `${waiting} short answers wait`
  return `${correct} of ${total} multiple choice right. ${short} for grading; ${waiting === 1 ? "it'll be marked" : "they'll be marked"} when the AI is back.`
}

/** The final grading with the rule results taken from the early grading, for the questions it covered. */
export function mergeRuleResults(graded: GradedQuestion[], rule: GradedQuestion[] | null): GradedQuestion[] {
  if (!rule || rule.length === 0) return graded
  const early = new Map(rule.map((q) => [q.question_index, q]))
  return graded.map((q) => early.get(q.question_index) ?? q)
}
