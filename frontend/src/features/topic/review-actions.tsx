'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowCounterClockwise, Sparkle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { RETRY_WAIT_TEXT } from '@/lib/learning/missed'
import { useOptionalTopic } from './topic-provider'

type ReviewActionsProps = {
  courseId: string
  topicId: string
  /** Questions missed in the last two attempts. "Retry what you missed" is hidden when there are none. */
  missedCount: number
  /** When the identical questions open again (ISO; the next local day, in the zone the server uses), or null when open now. */
  retryOpensAt?: string | null
  /** For a name that tells the buttons apart when several are on one page. */
  topicName?: string
  size?: 'sm' | 'md'
  /**
   * The main button is a primary (filled) one. A list of several topics gives it to one row only, so
   * five filled buttons do not compete; the rest are secondary. Default true.
   */
  emphasis?: boolean
}

/**
 * The two ways to review a topic that is due. "Retry what you missed" is a quiz of the questions
 * got wrong in the last two attempts (no model call); it opens from the next local day, because
 * answering the same question again straight away mostly tests short-term memory. "Fix it now"
 * writes a new 6-question set, focused on the concepts that were missed and mixing in a question
 * or two from a prerequisite topic; its questions are new, so it can be taken the same day. Both
 * lead to the topic's quiz; the attempt then updates mastery and the schedule like any quiz.
 */
export function ReviewActions({ courseId, topicId, missedCount, retryOpensAt, topicName, size = 'md', emphasis = true }: ReviewActionsProps) {
  const router = useRouter()
  const topic = useOptionalTopic()
  const [busy, setBusy] = React.useState<'retry' | 'fresh' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const retryNoteId = React.useId()
  // The server worked out when the retry opens (the student's own days) and refuses it before then; the
  // button follows, and opens by itself when the time comes. Disabled from the first render.
  const [openedAt, setOpenedAt] = React.useState<string | null>(null)
  const retryWaits = !!retryOpensAt && openedAt !== retryOpensAt
  React.useEffect(() => {
    if (!retryOpensAt) return
    // setTimeout holds at most about 24.8 days; a day is far less.
    const wait = Math.min(Math.max(Date.parse(retryOpensAt) - Date.now(), 0), 2_000_000_000)
    const timer = window.setTimeout(() => setOpenedAt(retryOpensAt), wait)
    return () => window.clearTimeout(timer)
  }, [retryOpensAt])
  const quizHref = `/courses/${courseId}/topics/${topicId}?view=quiz`
  const suffix = topicName ? ` for ${topicName}` : ''

  async function retry() {
    setBusy('retry')
    setError(null)
    try {
      const { quizSetId } = await apiFetch<{ quizSetId: string }>(`/api/topics/${topicId}/retry-quiz`, { method: 'POST' })
      router.push(`${quizHref}&set=${quizSetId}&start=1`)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not prepare the retry. Try again.')
      setBusy(null)
    }
  }

  async function fresh() {
    setBusy('fresh')
    setError(null)
    try {
      if (topic) {
        // On the topic page the provider follows the job and shows the quiz being written.
        const started = await topic.generateReview()
        if (!started) setError(topic.startError.quiz?.message ?? 'Could not start the review. Try again.')
        setBusy(null)
        return
      }
      const { jobId } = await apiFetch<{ jobId: string | null }>(`/api/topics/${topicId}/fresh-review`, { method: 'POST' })
      // The topic page follows the job it is told about, even one that finishes before the page has loaded.
      router.push(jobId ? `${quizHref}&job=${jobId}` : quizHref)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not start the review. Try again.')
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {missedCount > 0 ? (
          <Button
            size={size}
            variant={emphasis ? 'primary' : 'secondary'}
            icon={<ArrowCounterClockwise />}
            loading={busy === 'retry'}
            disabled={busy === 'fresh' || retryWaits}
            onClick={retry}
            aria-label={`Retry what you missed${suffix}`}
            aria-describedby={retryWaits ? retryNoteId : undefined}
          >
            Retry what you missed
          </Button>
        ) : null}
        <Button
          size={size}
          variant={(missedCount > 0 && !retryWaits) || !emphasis ? 'secondary' : 'primary'}
          icon={<Sparkle />}
          loading={busy === 'fresh'}
          disabled={busy === 'retry'}
          onClick={fresh}
          aria-label={`Fix it now${suffix}`}
        >
          Fix it now
        </Button>
      </div>
      {missedCount > 0 && retryWaits ? (
        <p id={retryNoteId} className="text-caption font-normal text-fg-2">
          {RETRY_WAIT_TEXT}
        </p>
      ) : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    </div>
  )
}
