'use client'

import { ReviewItem, reviewStatus } from '@/components/learning/review-item'
import { explainMistakeHref } from '@/lib/ask/explain'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import type { QuizReviewItem } from '@/lib/learning/quiz-review'
import { formatAnswer, formatKey } from './quiz-format'

export type ReviewEntry = {
  /** Zero-based position in the quiz. */
  index: number
  question: PublicQuizQuestion
  review: QuizReviewItem
  answer: string
}

/** Pair graded results with their questions and the student's answers. */
export function buildEntries(
  questions: PublicQuizQuestion[],
  review: QuizReviewItem[],
  answers: Record<string, string>
): ReviewEntry[] {
  return review
    .map((item) => ({
      index: item.questionIndex,
      question: questions[item.questionIndex],
      review: item,
      answer: answers[String(item.questionIndex)] ?? '',
    }))
    .filter((entry): entry is ReviewEntry => !!entry.question)
}

/**
 * Graded questions one under another, drawn by the same `ReviewItem` as the mock exam results:
 * status, the question, points, the student's answer, and for wrong or partial ones the correct
 * (or model) answer, the grader's feedback, what a written answer was graded against, why, and a
 * way to ask about it.
 */
export function ReviewList({ entries, courseId, topicId }: { entries: ReviewEntry[]; courseId: string; topicId: string }) {
  return (
    <ol className="divide-y divide-border">
      {entries.map(({ index, question, review, answer }) => {
        const shortAnswer = question.question_type === 'short_answer'
        // Typed answers are the student's own words; options and keys are the model's.
        const typed = shortAnswer || question.question_type === 'numerical'
        const given = formatAnswer(question, answer)
        return (
          <ReviewItem
            key={index}
            className="border-b-0 py-4 first:pt-4"
            number={index + 1}
            questionText={question.question_text}
            status={reviewStatus(review)}
            points={review.pointsPossible}
            pointsEarned={review.pointsEarned}
            studentAnswer={given || null}
            studentAnswerIsOption={!typed}
            correctAnswer={review.correctAnswer ? formatKey(question, review.correctAnswer) : null}
            correctLabel={shortAnswer ? 'Model answer' : 'Correct answer'}
            pickedMisconception={review.pickedMisconception}
            feedback={review.feedback}
            explanation={review.explanation}
            sources={review.sources}
            rubric={review.rubric}
            explainHref={explainMistakeHref(courseId, topicId, {
              questionText: question.question_text,
              studentAnswer: given || null,
              sources: review.sources,
            })}
          />
        )
      })}
    </ol>
  )
}
