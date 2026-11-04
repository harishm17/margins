'use client'

import { usePolling } from '@/lib/hooks/use-polling'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CaretRight, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { ReviewItem, reviewStatus } from '@/components/learning/review-item'
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
function FocusRow({ topic, courseId, showScore, weakest }: { topic: Graded['topics'][number]; courseId: string; showScore: boolean; weakest: boolean }) {
  const low = topic.percent < 60
  const href = topic.linkable && topic.topicId ? `/courses/${courseId}/topics/${topic.topicId}` : null
  return (
    <li className="relative flex items-center gap-4 border-b border-border py-3">
      <span className="min-w-0 flex-1 truncate text-body text-fg">
        {/* The whole row opens the topic; only the weakest one also has a button, so four rows do not say "Study" four times. */}
        {href ? (
          <Link href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-chip">
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
      <span className="flex w-[68px] shrink-0 justify-end">
        {href && weakest ? (
          <Button asChild size="sm" variant="secondary" className="relative z-10">
            <Link href={href} aria-label={`${topic.percent >= 100 ? 'Open' : 'Study'} ${topic.topicName}`}>
              {topic.percent >= 100 ? 'Open' : 'Study'}
            </Link>
          </Button>
        ) : href ? (
          <CaretRight aria-hidden="true" className="size-4 text-fg-3" />
        ) : null}
      </span>
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

  const renderQuestion = (question: Graded['questions'][number]) => (
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
          <div className="mt-4 flex flex-wrap gap-2">
            {result.practice ? <PracticeMissedButton courseId={result.courseId} submissionId={result.id} count={result.practice.count} /> : null}
            <StartExamButton courseId={result.courseId} examId={result.examId} variant="secondary" size="md" label="Retake exam" />
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
            {result.topics.map((topic, index) => (
              <FocusRow key={topic.topicId ?? topic.topicName} topic={topic} courseId={result.courseId} showScore={result.topics.length > 1} weakest={index === 0} />
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
