'use client'

import { usePolling } from '@/lib/hooks/use-polling'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/components/ui/toaster'
import { useJob } from '@/features/jobs/use-job'
import { apiFetch, isApiError } from '@/lib/api/client'
import { GRADING_WAITING_TEXT, GRADING_WAITING_TITLE } from '@/lib/ai/messages'
import { describeJobFailure } from '@/lib/jobs/failure-message'
import { isWaitingForAi } from '@/lib/jobs/poll-job'
import { partialLine } from '@/lib/learning/quiz-partial'
import type { QuizReviewItem } from '@/lib/learning/quiz-review'
import type { WaitingQuiz } from '@/lib/learning/quiz-submissions'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { PartialResults, type QuizResult } from './quiz-results'

/** What the result route sends for a quiz that was graded after waiting (the same as a quiz graded at once). */
type GradedResponse = {
  status: 'graded'
  score: number
  earnedPoints: number
  totalPoints: number
  bestScore: number
  review: QuizReviewItem[]
  answers: Record<string, string>
  confidence?: Record<string, number>
  outcome?: QuizResult['outcome']
  helpAfterMiss?: QuizResult['helpAfterMiss']
  missedConcepts?: QuizResult['missedConcepts']
}

export const toQuizResult = (response: GradedResponse): QuizResult => ({
  score: response.score,
  earnedPoints: response.earnedPoints,
  totalPoints: response.totalPoints,
  bestScore: response.bestScore,
  review: response.review,
  outcome: response.outcome,
  answers: response.answers,
  confidence: response.confidence,
  helpAfterMiss: response.helpAfterMiss,
  missedConcepts: response.missedConcepts,
})

type QuizWaitingProps = {
  courseId?: string
  topicId: string
  item: WaitingQuiz
  /** The questions of the quiz's set, for the partial view. */
  questions?: PublicQuizQuestion[]
  /** 'page' fills the quiz view right after submitting; 'card' sits above the lobby. */
  variant: 'page' | 'card'
  /** The server no longer lists it as waiting: it was graded, so ask for the result now. */
  gone?: boolean
  /** The quiz was graded: show its results. */
  onGraded: (item: WaitingQuiz, result: QuizResult) => void
  /** Leave the full-page panel for the lobby (the card stays there). */
  onLeave?: () => void
  /** The stored quiz was removed. */
  onDismiss?: (item: WaitingQuiz) => void
}

/**
 * A submitted quiz whose short answers wait for the AI. The answers are stored, the grading job
 * waits (the same wait exam grading has) and the results appear here by themselves. If it did not
 * finish, "Grade again" starts it once more.
 */
export function QuizWaiting({ courseId, topicId, item, questions, variant, gone = false, onGraded, onLeave, onDismiss }: QuizWaitingProps) {
  const router = useRouter()
  const [regradeJobId, setRegradeJobId] = React.useState<string | null>(null)
  const [regrading, setRegrading] = React.useState(false)
  const [dismissing, setDismissing] = React.useState(false)
  const jobId = regradeJobId ?? (item.state === 'failed' ? null : item.jobId)
  const done = React.useRef(false)
  const onGradedRef = React.useRef(onGraded)
  React.useEffect(() => {
    onGradedRef.current = onGraded
  })

  /** Asks for the result; true once the quiz is graded and shown. */
  const check = React.useCallback(async (): Promise<boolean> => {
    if (done.current) return true
    try {
      const response = await apiFetch<{ status: 'pending' } | GradedResponse>(
        `/api/topics/${topicId}/quiz-submissions/${item.submissionId}`
      )
      if (response.status !== 'graded') return false
      done.current = true
      onGradedRef.current(item, toQuizResult(response))
      React.startTransition(() => router.refresh())
      return true
    } catch {
      return false
    }
  }, [topicId, item, router])


  React.useEffect(() => {
    if (!gone) return
    let cancelled = false
    void (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [gone, check])
  const [jobFailure, setJobFailure] = React.useState<string | null>(null)
  const { job, timedOut } = useJob(jobId, {
    timeoutMs: 300_000,
    onSettled: async (result) => {
      if (result.state === 'completed') {
        // Stored a moment ago: the result is ready, or about to be (another page may be applying it).
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (await check()) return
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      } else if (result.state === 'failed') {
        setJobFailure(result.job?.errorCode ?? 'QUIZ_GRADING_FAILED')
        router.refresh()
      }
    },
  })
  const waiting = job ? isWaitingForAi(job) : item.state === 'waiting'

  // While it waits for the AI (longer than a poll lasts), or after the poller gave up, look now and then.
  const slow = waiting || timedOut
  usePolling(() => void check(), { active: !!jobId && slow, intervalMs: 20_000, maxPolls: 45 })

  async function regrade() {
    setRegrading(true)
    try {
      const started = await apiFetch<{ jobId: string | null }>(
        `/api/topics/${topicId}/quiz-submissions/${item.submissionId}/regrade`,
        { method: 'POST' }
      )
      setJobFailure(null)
      setRegradeJobId(started.jobId)
      router.refresh()
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't start grading. Try again.")
    } finally {
      setRegrading(false)
    }
  }

  /** Removes the stored quiz and its answers; the student chose not to wait for or redo it. */
  async function dismiss() {
    setDismissing(true)
    try {
      await apiFetch(`/api/topics/${topicId}/quiz-submissions/${item.submissionId}`, { method: 'DELETE' })
      onDismiss?.(item)
      router.refresh()
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't dismiss it. Try again.")
    } finally {
      setDismissing(false)
    }
  }

  const failed = !regradeJobId && (item.state === 'failed' || jobFailure !== null)
  const frame =
    variant === 'page'
      ? 'mx-auto flex max-w-[480px] flex-col items-center py-16 text-center'
      : 'flex max-w-[720px] flex-col rounded-card border border-border px-5 py-4'

  if (failed) {
    return (
      <div className={variant === 'page' ? 'mx-auto max-w-[560px] py-4' : 'max-w-[720px]'}>
        <InlineAlert
          tone="danger"
          icon={<WarningCircle />}
          title="Grading didn't finish"
          action={
            <div className="flex items-center gap-2">
              <Button variant="ghost" loading={dismissing} onClick={dismiss}>
                Dismiss
              </Button>
              <Button variant="secondary" icon={<ArrowClockwise />} loading={regrading} onClick={regrade}>
                Grade again
              </Button>
            </div>
          }
        >
          Your answers are saved. {describeJobFailure(jobFailure ?? item.errorCode, null, 'grade_quiz')}
        </InlineAlert>
        {variant === 'page' && onLeave ? (
          <Button variant="ghost" className="-ml-3.5 mt-4" onClick={onLeave}>
            Back to quiz
          </Button>
        ) : null}
      </div>
    )
  }

  const waitingPanel = (
    <div role="status" aria-live="polite" className={frame}>
      {waiting ? (
        <>
          <h2 className="text-heading text-fg">{GRADING_WAITING_TITLE}</h2>
          <p className="mt-1.5 text-small text-fg-2">{GRADING_WAITING_TEXT}</p>
        </>
      ) : (
        <>
          <h2 className="text-heading text-fg">Grading your quiz</h2>
          <p className="mt-1.5 text-small text-fg-2">
            {timedOut
              ? 'Still working in the background. You can leave this page and come back.'
              : 'Short answers are read one by one, so this can take a minute. You can leave this page.'}
          </p>
          <Progress aria-label="Grading progress" className="mt-6 max-w-[320px]" indeterminate value={job?.progressPercent ?? 0} />
        </>
      )}
      {variant === 'page' && onLeave ? (
        <Button variant="ghost" className="mt-6" onClick={onLeave}>
          Back to quiz
        </Button>
      ) : null}
    </div>
  )

  // The multiple choice answers were graded at once: show them, then the wait for the short answers.
  if (item.partial && questions && courseId && variant === 'page') {
    return (
      <div className="flex flex-col gap-8">
        <PartialResults courseId={courseId} topicId={topicId} questions={questions} partial={item.partial} />
        {waitingPanel}
      </div>
    )
  }
  if (item.partial && variant === 'card') {
    return (
      <div className="flex flex-col gap-1">
        <p className="max-w-[720px] text-small text-fg-2">{partialLine(item.partial.summary)}</p>
        {waitingPanel}
      </div>
    )
  }
  return waitingPanel
}
