'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChatCircleText, CheckCircle, CircleHalf, Question, XCircle } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { MathText } from '@/components/ui/math-text'
import { QuestionText, stemHasBlocks } from '@/components/ui/question-text'
import { outcomeLabel } from '@/lib/learning/outcome-words'
import type { RubricLine, RubricResult } from '@/lib/learning/rubric'
import type { SourceRef } from '@/lib/topics/sources'
import { cn } from '@/lib/utils'
import { SourceLine } from './source-link'

export type ReviewStatus = 'correct' | 'partial' | 'incorrect' | 'review'

/** The status of a graded question: full marks, some marks, none, or not graded automatically. */
export function reviewStatus(item: { isCorrect: boolean; pointsEarned: number; needsReview?: boolean }): ReviewStatus {
  if (item.needsReview) return 'review'
  if (item.isCorrect) return 'correct'
  return item.pointsEarned > 0 ? 'partial' : 'incorrect'
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  correct: outcomeLabel({ correct: true }),
  partial: 'Partly correct',
  incorrect: outcomeLabel({}),
  review: 'Needs review',
}

/** "I don't know" is not a miss: nothing was attempted, so it gets a neutral mark and its own words (no red "Not quite"). */
const statusLabel = (status: ReviewStatus, unknown: boolean) => (unknown ? outcomeLabel({ idk: true }) : STATUS_LABEL[status])

function StatusIcon({ status, unknown }: { status: ReviewStatus; unknown: boolean }) {
  const common = 'size-5 shrink-0'
  if (unknown) return <Question aria-hidden="true" weight="fill" className={cn(common, 'text-fg-3')} />
  switch (status) {
    case 'correct':
      return <CheckCircle aria-hidden="true" weight="fill" className={cn(common, 'text-accent')} />
    case 'partial':
      return <CircleHalf aria-hidden="true" weight="fill" className={cn(common, 'text-warning')} />
    case 'review':
      return <Question aria-hidden="true" weight="fill" className={cn(common, 'text-fg-3')} />
    default:
      return <XCircle aria-hidden="true" weight="fill" className={cn(common, 'text-danger')} />
  }
}

export type ReviewItemProps = {
  /** The number shown to the student (1-based). */
  number: number
  questionText: string
  status: ReviewStatus
  points: number
  pointsEarned: number
  /** What the student answered; null when they left it blank. */
  studentAnswer: string | null
  /** The answer is an option the model wrote ("B. text"), so it may hold math. Typed answers are plain. */
  studentAnswerIsOption?: boolean
  /** The student pressed "I don't know": no answer on purpose, which reads differently from a blank. */
  dontKnow?: boolean
  /** Shown for wrong, partial and ungraded answers. */
  correctAnswer?: string | null
  /** "Correct answer" (the default) or "Model answer" for a written one. */
  correctLabel?: string
  /** The grader's note (short answers). */
  feedback?: string | null
  /** Why the answer is what it is (markdown). */
  explanation?: string | null
  /** The topic the question belongs to, shown as a small badge. */
  topicName?: string | null
  /** Where in the student's files the question comes from: "From notes.pdf, p. 4". */
  sources?: SourceRef[]
  /** The wrong idea the picked option stands for (a wrong multiple-choice pick), worded as a fact about the option. */
  pickedMisconception?: string | null
  /** What a written answer was graded against, with a verdict per line when the grader gave one. */
  rubric?: RubricLine[] | null
  /** Opens Ask with this question, the student's answer and the sources already written. Shown for a miss. */
  explainHref?: string | null
  /** Next to the rubric: the "Disagree" action, when the page can ask for a regrade. */
  gradeAction?: React.ReactNode
  className?: string
}

/** Past this many characters a question is shown as two lines with a "Show full question" button. */
const QUESTION_CLAMP_CHARS = 140

const formatPoints = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="mt-0.5 text-small text-fg">{children}</dd>
    </div>
  )
}

const RUBRIC_WORDS: Record<RubricResult, string> = { met: 'Met', partly: 'Partly', not_met: 'Missing' }

function RubricMark({ result }: { result: RubricResult | null }) {
  const common = 'mt-0.5 size-4 shrink-0'
  if (result === 'met') return <CheckCircle aria-hidden="true" weight="fill" className={cn(common, 'text-accent')} />
  if (result === 'partly') return <CircleHalf aria-hidden="true" weight="fill" className={cn(common, 'text-warning')} />
  if (result === 'not_met') return <XCircle aria-hidden="true" weight="fill" className={cn(common, 'text-danger')} />
  // No verdict recorded: a plain bullet, the line is still what the grader looked for.
  return <span aria-hidden="true" className="mt-2 ml-1.5 mr-1 size-1 shrink-0 rounded-full bg-fg-3" />
}

/** The key points a written answer is graded against, with the score for the answer as a whole. */
function Rubric({
  rubric,
  points,
  pointsEarned,
  action,
  number,
}: {
  number: number
  rubric: RubricLine[]
  points: number
  pointsEarned: number
  action?: React.ReactNode
}) {
  const marked = rubric.some((line) => line.result !== null)
  return (
    <div role="group" aria-label={`How question ${number} was graded`} className="rounded-control bg-surface-2 px-3.5 py-3">
      <h3 className="text-caption text-fg-3">{marked ? 'What the grader checked' : 'What the grader looked for'}</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {rubric.map((line, index) => (
          <li key={index} className="flex items-start gap-2 text-small text-fg">
            <RubricMark result={line.result} />
            <span className="min-w-0 flex-1">
              <MathText>{line.text}</MathText>
            </span>
            {line.result ? <span className="shrink-0 text-caption text-fg-2">{RUBRIC_WORDS[line.result]}</span> : null}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-caption font-normal text-fg-2">
        Scored <span className="tabular">{formatPoints(pointsEarned)}</span> of <span className="tabular">{formatPoints(points)}</span>{' '}
        for the whole answer. The grader gives one score, not one per line.
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/**
 * One graded question: status, the question, the points, the student's answer and, when it was
 * not fully right, the correct (or model) answer, the grader's feedback, what a written answer was
 * graded against, the explanation, and a way to ask about it. Shared by the mock exam results and
 * the quiz review.
 */
export function ReviewItem({
  number,
  questionText,
  status,
  points,
  pointsEarned,
  studentAnswer,
  studentAnswerIsOption,
  dontKnow,
  correctAnswer,
  correctLabel = 'Correct answer',
  feedback,
  explanation,
  topicName,
  sources,
  pickedMisconception,
  rubric,
  explainHref,
  gradeAction,
  className,
}: ReviewItemProps) {
  const showKey = status !== 'correct'
  const blocks = stemHasBlocks(questionText)
  const unknown = !!dontKnow && !studentAnswer && status === 'incorrect'
  // A long question is the same text the student just answered: one tap shows all of it, the rest of the card is the new information.
  const longQuestion = questionText.length > QUESTION_CLAMP_CHARS || blocks
  const [questionOpen, setQuestionOpen] = React.useState(false)
  const questionId = React.useId()
  return (
    <li className={cn('flex gap-3 border-b border-border py-5 first:pt-0 last:border-b-0', className)}>
      <StatusIcon status={status} unknown={unknown} />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{statusLabel(status, unknown)}. </span>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2 text-body-strong text-fg">
            <span className="tabular text-fg-3">{number}</span>
            <div className="min-w-0 flex-1">
              <div id={questionId} className={cn(longQuestion && !questionOpen && 'max-h-[3.25rem] overflow-hidden')}>
                {blocks ? <QuestionText compact>{questionText}</QuestionText> : <MathText>{questionText}</MathText>}
              </div>
              {longQuestion ? (
                <button
                  type="button"
                  aria-expanded={questionOpen}
                  aria-controls={questionId}
                  onClick={() => setQuestionOpen((open) => !open)}
                  className="mt-1 inline-flex min-h-6 items-center rounded-chip text-small font-normal text-fg-2 underline-offset-2 hover:text-fg hover:underline max-sm:min-h-11"
                >
                  {questionOpen ? 'Hide full question' : 'Show full question'}
                </button>
              ) : null}
            </div>
          </div>
          <span className="shrink-0 tabular text-small text-fg-2">
            {formatPoints(pointsEarned)} of {formatPoints(points)} {points === 1 ? 'pt' : 'pts'}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {topicName ? <Badge>{topicName}</Badge> : null}
          {status === 'review' ? <Badge tone="warning">Needs review</Badge> : null}
          {status === 'partial' ? <Badge tone="warning">Partly correct</Badge> : null}
          {unknown ? <Badge>{outcomeLabel({ idk: true })}</Badge> : null}
        </div>

        <dl className="mt-3 flex flex-col gap-3">
          <Detail label="Your answer">
            {studentAnswer ? (
              <span className="whitespace-pre-wrap break-words">
                {studentAnswerIsOption ? <MathText>{studentAnswer}</MathText> : studentAnswer}
              </span>
            ) : dontKnow ? (
              // The student chose this: it is their answer, said in their words.
              <span>I don&apos;t know</span>
            ) : (
              // A blank is not an answer: it reads differently from one.
              <span className="inline-flex items-center rounded-chip border border-dashed border-control px-1.5 text-caption text-fg-2">
                Left blank
              </span>
            )}
          </Detail>
          {showKey && correctAnswer ? (
            <Detail label={correctLabel}>
              <span className="whitespace-pre-wrap break-words">
                <MathText>{correctAnswer}</MathText>
              </span>
            </Detail>
          ) : null}
          {showKey && pickedMisconception ? (
            <Detail label="About your pick">
              <span className="whitespace-pre-wrap break-words">
                You picked the answer you&apos;d get if you think <MathText>{pickedMisconception.replace(/[.\s]+$/, '')}</MathText>.
              </span>
            </Detail>
          ) : null}
          {feedback ? (
            <Detail label="Feedback">
              <span className="whitespace-pre-wrap break-words text-fg-2">
                <MathText>{feedback}</MathText>
              </span>
            </Detail>
          ) : null}
          {showKey && explanation ? (
            <Detail label="Why">
              <LazyMarkdown variant="compact">{explanation}</LazyMarkdown>
            </Detail>
          ) : null}
        </dl>

        {rubric && rubric.length > 0 ? (
          <div className="mt-3">
            <Rubric number={number} rubric={rubric} points={points} pointsEarned={pointsEarned} action={gradeAction} />
          </div>
        ) : gradeAction ? (
          <div className="mt-3">{gradeAction}</div>
        ) : null}

        {sources && sources.length > 0 ? <SourceLine sources={sources} className="mt-3" /> : null}

        {/* A blank has no mistake to explain. */}
        {explainHref && studentAnswer && (status === 'partial' || status === 'incorrect') ? (
          <div className="mt-3">
            <Button asChild size="sm" variant="secondary" icon={<ChatCircleText />}>
              <Link href={explainHref}>Explain this mistake</Link>
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  )
}
