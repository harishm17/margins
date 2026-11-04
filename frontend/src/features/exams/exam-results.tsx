'use client'

import { usePolling } from '@/lib/hooks/use-polling'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CaretDown, CaretRight, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { ReviewItem, reviewStatus } from '@/components/learning/review-item'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { ProgressRing, scoreRingSize } from '@/components/ui/progress-ring'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import { useJob } from '@/features/jobs/use-job'
import { explainMistakeHref } from '@/lib/ask/explain'
import { GRADING_WAITING_TEXT, GRADING_WAITING_TITLE } from '@/lib/ai/messages'
import { calibrationLine, examCalibration, isSureAndWrong } from '@/lib/exams/results'
import { describeJobFailure } from '@/lib/jobs/failure-message'
import { isWaitingForAi } from '@/lib/jobs/poll-job'
import { cn } from '@/lib/utils'
import type { ExamResult } from '@/server/queries/mock-exams'
import { DisagreeButton, GradeAgainButton, PracticeMissedButton, StartExamButton } from './exam-actions'
import { formatScore } from './exam-options'

type Graded = Extract<ExamResult, { status: 'graded' }>
type NotGraded = Extract<ExamResult, { status: 'grading' | 'failed' }>

type Filter = 'all' | 'missed' | 'review'

const pointsText = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** The page says this while grading waits for the AI (copy for review). */
export const WAITING_TITLE = GRADING_WAITING_TITLE
export const WAITING_TEXT = GRADING_WAITING_TEXT

/**
 * Grading in progress: a calm panel that refreshes the page when the job finishes. While the AI is
 * unavailable the grading job waits instead of failing, and the panel says the answers are saved.
 */
export function GradingPanel({ result }: { result: NotGraded }) {
  const router = useRouter()
  const { job, timedOut } = useJob(result.jobId, {
    timeoutMs: 300_000,
    onSettled: () => router.refresh(),
  })
  const waiting = job ? isWaitingForAi(job) : result.waitingForAi

  // With no job to follow (it was just created), or while it waits for the AI (which can take
  // longer than the poller waits), look again now and then.
  const slow = waiting || timedOut
  usePolling(() => router.refresh(), { active: !result.jobId || slow, intervalMs: slow ? 20_000 : 4000, maxPolls: slow ? 45 : 75 })

  if (waiting) {
    return (
      <div role="status" aria-live="polite" className="mx-auto flex max-w-[480px] flex-col items-center py-16 text-center">
        <h2 className="text-heading text-fg">{WAITING_TITLE}</h2>
        <p className="mt-1.5 text-small text-fg-2">{WAITING_TEXT}</p>
      </div>
    )
  }

  return (
    <div role="status" aria-live="polite" className="mx-auto flex max-w-[480px] flex-col items-center py-16 text-center">
      <h2 className="text-heading text-fg">Grading your exam</h2>
      <p className="mt-1.5 text-small text-fg-2">
        {timedOut
          ? 'Still working in the background. You can leave this page and come back.'
          : 'Short answers are read one by one, so this can take a minute. You can leave this page.'}
      </p>
      <Progress
        aria-label="Grading progress"
        className="mt-6 max-w-[320px]"
        indeterminate
        value={job?.progressPercent ?? 0}
      />
    </div>
  )
}

/** Grading did not finish. The answers are safe; "Grade again" tries once more. */
export function GradingFailed({ result }: { result: NotGraded }) {
  return (
    <div className="max-w-[560px] py-4">
      <InlineAlert
        tone="danger"
        icon={<WarningCircle />}
        title="Grading didn't finish"
        action={<GradeAgainButton courseId={result.courseId} examId={result.examId} submissionId={result.id} size="md" navigate={false} />}
      >
        Your answers are saved. {describeJobFailure(result.errorCode, result.errorMessage, 'grade_exam')}
      </InlineAlert>
      <div className="mt-5">
        <Button asChild variant="link">
          <Link href={`/courses/${result.courseId}/exams`}>Back to mock exams</Link>
        </Button>
      </div>
    </div>
  )
}

/** A topic's row under "Where to focus". With one topic only, its score is the whole exam's, shown by the ring above. */
function FocusRow({ topic, courseId, showScore }: { topic: Graded['topics'][number]; courseId: string; showScore: boolean }) {
  const low = topic.percent < 60
  const href = topic.linkable && topic.topicId ? `/courses/${courseId}/topics/${topic.topicId}` : null
  return (
    <li className="relative flex items-center gap-4 border-b border-border py-3">
      <span className="min-w-0 flex-1 truncate text-body text-fg">
        {/* The whole row opens the topic. The one recommended first step, for the weakest topic, is the button under the score. */}
        {href ? (
          <Link href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-chip max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
            {topic.topicName}
          </Link>
        ) : (
          topic.topicName
        )}
      </span>
      {showScore ? (
        <>
          {/* The track has an edge, and 0% is an empty track: a dot at 0% looked like a bar that had not drawn. */}
          <span aria-hidden="true" className="hidden h-1.5 w-32 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-control sm:block">
            <span
              className={cn('block h-full rounded-full', low ? 'bg-learning' : 'bg-accent')}
              style={{ width: `${Math.max(0, Math.min(100, topic.percent))}%` }}
            />
          </span>
          <span className="w-12 shrink-0 text-right tabular text-body-strong text-fg">{formatScore(topic.percent)}</span>
        </>
      ) : null}
      <span className="flex w-6 shrink-0 justify-end">{href ? <CaretRight aria-hidden="true" className="size-4 text-fg-3" /> : null}</span>
    </li>
  )
}

const STATUS_WORD: Record<ReturnType<typeof reviewStatus>, { label: string; tone: 'accent' | 'warning' | 'danger' | 'neutral' }> = {
  correct: { label: 'Correct', tone: 'accent' },
  partial: { label: 'Partly correct', tone: 'warning' },
  incorrect: { label: 'Missed', tone: 'danger' },
  review: { label: 'Needs review', tone: 'neutral' },
}

/**
 * One question as a labelled row (number, outcome, the start of the question, points) that opens to the full review: a phone
 * shows twenty of them on a short page instead of twenty long reviews. Only an open row mounts the review, so the regrade
 * control and the answer key appear where the student is reading.
 */
function QuestionRow({
  number,
  questionText,
  status,
  points,
  pointsEarned,
  open,
  onToggle,
  children,
}: {
  number: number
  questionText: string
  status: ReturnType<typeof reviewStatus>
  points: number
  pointsEarned: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const panelId = React.useId()
  const word = STATUS_WORD[status]
  const preview = questionText.replace(/\s+/g, ' ').replace(/\$/g, '').trim()
  return (
    <li className="border-b border-border last:border-b-0">
      <h4 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-3 py-2.5 text-left focus-visible:rounded-control"
        >
          <span className="tabular w-6 shrink-0 text-body-strong text-fg-3">{number}</span>
          <Badge tone={word.tone} className="shrink-0">
            {word.label}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-small text-fg-2">{preview}</span>
          {/* The open review says the points itself. */}
          {open ? null : (
            <span className="shrink-0 tabular text-small text-fg-2 max-sm:sr-only">
              {pointsText(pointsEarned)} of {pointsText(points)} {points === 1 ? 'pt' : 'pts'}
            </span>
          )}
          <CaretDown aria-hidden="true" className={cn('size-4 shrink-0 text-fg-3 transition-transform duration-180', open && 'rotate-180')} />
        </button>
      </h4>
      {open ? (
        <ul id={panelId} className="pb-1 pl-9">
          {children}
        </ul>
      ) : null}
    </li>
  )
}

/** A second grading is running: the page keeps the earlier results and refreshes when the new ones land. */
function RegradeBanner({ jobId, waitingForAi }: { jobId: string; waitingForAi: boolean }) {
  const router = useRouter()
  const { job } = useJob(jobId, { timeoutMs: 300_000, onSettled: () => router.refresh() })
  const waiting = job ? isWaitingForAi(job) : waitingForAi
  usePolling(() => router.refresh(), { active: waiting, intervalMs: 20_000, maxPolls: 45 })
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-control bg-surface-2 px-3.5 py-3 text-small text-fg">
      <Spinner className="text-accent" />
      <span>
        {waiting
          ? 'Grading again will finish when AI is available again. These results stay until then.'
          : 'Grading again. These results stay until the new ones are ready, and this page updates by itself.'}
      </span>
    </div>
  )
}

/** The graded results: score, where to focus, and every question with its review. */
export function GradedResults({ result, submittedLabel }: { result: Graded; submittedLabel: string }) {
  const [filter, setFilter] = React.useState<Filter>('all')
  const missed = result.questions.filter((q) => !q.isCorrect && !q.needsReview)
  const review = result.questions.filter((q) => q.needsReview)
  const shown = filter === 'all' ? result.questions : filter === 'missed' ? missed : review
  // The answers the student was sure about and got wrong come first (spec §5.9).
  const sureWrong = shown.filter(isSureAndWrong)
  const others = shown.filter((question) => !isSureAndWrong(question))
  const calibration = examCalibration(result.questions)
  // The weakest topic that has a page to open and something left to learn (topics come weakest first).
  const reviewTopic = result.topics.find((topic) => topic.linkable && topic.topicId && topic.percent < 100) ?? null
  // The first miss to read: one the student was sure about if there is one, otherwise the first missed. The rest start collapsed.
  const firstMiss = result.questions.find(isSureAndWrong) ?? result.questions.find((q) => !q.isCorrect && !q.needsReview) ?? null
  const [open, setOpen] = React.useState<Set<number>>(() => new Set(firstMiss ? [firstMiss.questionIndex] : []))
  const allOpen = shown.length > 0 && shown.every((q) => open.has(q.questionIndex))
  const toggleQuestion = (index: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const setAll = (expand: boolean) => setOpen(new Set(expand ? shown.map((q) => q.questionIndex) : []))

  const renderQuestion = (question: Graded['questions'][number]) => (
    <QuestionRow
      key={question.questionIndex}
      number={question.questionIndex + 1}
      questionText={question.questionText}
      status={reviewStatus(question)}
      points={question.points}
      pointsEarned={question.pointsEarned}
      open={open.has(question.questionIndex)}
      onToggle={() => toggleQuestion(question.questionIndex)}
    >
      {renderItem(question)}
    </QuestionRow>
  )

  const renderItem = (question: Graded['questions'][number]) => (
    <ReviewItem
      key={question.questionIndex}
      number={question.questionIndex + 1}
      questionText={question.questionText}
      status={reviewStatus(question)}
      points={question.points}
      pointsEarned={question.pointsEarned}
      studentAnswer={question.studentAnswer}
      studentAnswerIsOption={question.questionType === 'multiple_choice'}
      correctAnswer={question.correctAnswer}
      feedback={question.feedback}
      topicName={question.topicName}
      sources={question.sources}
      correctLabel={question.questionType === 'short_answer' ? 'Model answer' : 'Correct answer'}
      rubric={question.rubric}
      explainHref={explainMistakeHref(result.courseId, question.topicId, {
        questionText: question.questionText,
        studentAnswer: question.studentAnswer,
        sources: question.sources,
      })}
      gradeAction={
        question.questionType === 'short_answer' && question.studentAnswer ? (
          <DisagreeButton examId={result.examId} submissionId={result.id} disabled={!!result.regradeJobId} />
        ) : null
      }
    />
  )

  const options: { value: Filter; label: string }[] = [
    { value: 'all', label: `All ${result.questions.length}` },
    { value: 'missed', label: `Missed ${missed.length}` },
    ...(review.length > 0 ? [{ value: 'review' as const, label: `Needs review ${review.length}` }] : []),
  ]

  return (
    <div className="flex flex-col gap-12">
      {result.regradeJobId ? <RegradeBanner jobId={result.regradeJobId} waitingForAi={result.regradeWaitingForAi} /> : null}
      <section aria-label="Your score" className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <ProgressRing
          size={scoreRingSize(result.score)}
          value={result.totalPoints > 0 ? result.score / 100 : null}
          aria-label={`Score ${formatScore(result.score)}`}
          label={formatScore(result.score)}
        />
        <div className="min-w-0">
          <p className={cn('tabular text-fg', result.score > 0 ? 'text-display' : 'text-title')}>
            {pointsText(result.earnedPoints)} <span className="text-fg-2">of {pointsText(result.totalPoints)} points</span>
          </p>
          <p className="mt-1 text-small text-fg-2">
            Submitted {submittedLabel}
          </p>
          {calibration ? <p className="mt-1 text-small text-fg-2">{calibrationLine(calibration)}</p> : null}
        </div>
      </section>

      {/* One recommended order, said once. Retaking the same questions is the quiet choice: the repair comes first. */}
      <section aria-labelledby="exam-next" className="flex flex-col gap-4">
        {reviewTopic || result.practice ? (
          <>
            <h2 id="exam-next" className="text-heading text-fg">
              What to do next
            </h2>
            <ol className="flex flex-col gap-3">
              {reviewTopic ? (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span aria-hidden="true" className="tabular text-body-strong text-fg-3">1.</span>
                  <Button asChild variant="primary" size="md">
                    <Link href={`/courses/${result.courseId}/topics/${reviewTopic.topicId}`}>{`Review ${reviewTopic.topicName}`}</Link>
                  </Button>
                  <span className="text-small text-fg-2">Your weakest topic in this exam.</span>
                </li>
              ) : null}
              {result.practice ? (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span aria-hidden="true" className="tabular text-body-strong text-fg-3">{reviewTopic ? '2.' : '1.'}</span>
                  <PracticeMissedButton
                    courseId={result.courseId}
                    submissionId={result.id}
                    count={result.practice.count}
                    variant={reviewTopic ? 'secondary' : 'primary'}
                  />
                  {reviewTopic ? <span className="text-small text-fg-2">Then, to check it stuck.</span> : null}
                </li>
              ) : null}
            </ol>
          </>
        ) : (
          <h2 id="exam-next" className="sr-only">
            What to do next
          </h2>
        )}
        <div>
          <h3 className="text-caption text-fg-3">Other ways to study</h3>
          <div className="-ml-2.5 mt-1 flex flex-wrap gap-2">
            <StartExamButton courseId={result.courseId} examId={result.examId} variant="ghost" size="md" label="Retake exam" />
            <Button asChild variant="ghost">
              <Link href={`/courses/${result.courseId}/exams`}>Back to exams</Link>
            </Button>
          </div>
        </div>
      </section>

      {result.topics.length > 0 ? (
        <section aria-labelledby="where-to-focus">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="where-to-focus" className="text-heading text-fg">
              Where to focus
            </h2>
            {result.topics.length > 1 ? <span className="text-small text-fg-3">Weakest first</span> : null}
          </div>
          <ul className="mt-3 border-t border-border">
            {result.topics.map((topic) => (
              <FocusRow key={topic.topicId ?? topic.topicName} topic={topic} courseId={result.courseId} showScore={result.topics.length > 1} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="exam-questions-review">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="exam-questions-review" className="text-heading text-fg">
            Questions
          </h2>
          <SegmentedControl aria-label="Show questions" value={filter} onValueChange={setFilter} options={options} />
        </div>
        {shown.length > 1 ? (
          <div className="mt-2 -ml-2.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAll(!allOpen)}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
          </div>
        ) : null}
        {shown.length === 0 ? (
          <p className="mt-6 text-small text-fg-2">
            {filter === 'missed' ? 'You got every question right.' : 'Nothing needs review.'}
          </p>
        ) : (
          <>
            {sureWrong.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-body-strong text-fg">
                  You were sure about these <span className="tabular text-fg-3">({sureWrong.length})</span>
                </h3>
                <p className="mt-0.5 text-small text-fg-2">
                  You felt sure and it was wrong. A miss like this is the one you remember best, so read the answer closely.
                </p>
                <ol className="mt-2">{sureWrong.map(renderQuestion)}</ol>
              </div>
            ) : null}
            {others.length > 0 ? (
              <div className="mt-5">
                {sureWrong.length > 0 ? <h3 className="text-body-strong text-fg">Everything else</h3> : null}
                <ol className={sureWrong.length > 0 ? 'mt-2' : undefined}>{others.map(renderQuestion)}</ol>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
