'use client'

import { usePolling } from '@/lib/hooks/use-polling'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { JobStatus } from '@/components/ui/job-status'
import { FailureList, GenerationProgress, useGenerationProgress } from './building-content'
import { useExtraction } from './extraction'
import { SetupStartForm } from './setup-plan'
import { AiBlockedNote } from '@/features/ai/ai-status'
import { topicOriginSentence, type TopicListState } from '@/lib/course-setup'
import type { GenerationState, JobRef } from '@/server/queries/course'

/** Step 2 content: topics being found, to review or confirm, or waiting on files. */
export function CheckTopicsStep({
  courseId,
  extractJob,
  extractFailure,
  topics,
  topicPreview,
  label,
  filesProcessing,
  filesRead,
  filesTotal,
}: {
  courseId: string
  extractJob: JobRef | null
  extractFailure: string | null
  /** The topic list and where it came from (lib/course-setup.ts). */
  topics: TopicListState
  /** The first topic names, shown under the count (names only; "+N more" for the rest). */
  topicPreview: string[]
  /** The step's action: "Review topics" or "Confirm topics". */
  label: string
  filesProcessing: boolean
  /** Files that have been read, and all files, for "1 of 2 read" while the others are in progress. */
  filesRead: number
  filesTotal: number
}) {
  const router = useRouter()
  const extraction = useExtraction(courseId, extractJob)
  const topicCount = topics.total
  const editHref = `/courses/${courseId}/topics?edit=1`
  const failureAlert = extractFailure ? (
    <InlineAlert
      tone="danger"
      title="We couldn't find topics"
      action={
        <Button size="sm" variant="secondary" onClick={extraction.start} loading={extraction.starting} disabled={!!extraction.blocked}>
          Try again
        </Button>
      }
    >
      {extractFailure}
    </InlineAlert>
  ) : null
  const foundRef = React.useRef<HTMLDivElement>(null)
  const wasWaiting = React.useRef(topicCount === 0)

  // The step above keeps its size, so when the topics arrive the next action can be below the fold on a
  // phone. Bring it into view once, only if it is not already, and only when it arrived while the student waited.
  React.useEffect(() => {
    if (topicCount === 0) {
      wasWaiting.current = true
      return
    }
    if (!wasWaiting.current) return
    wasWaiting.current = false
    const element = foundRef.current
    if (!element) return
    const box = element.getBoundingClientRect()
    if (box.top >= 0 && box.bottom <= window.innerHeight) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [topicCount])

  // The AI service starts topic finding a moment after the last file is read; look for it for a minute.
  const waitingForJob = !extraction.running && !extraction.failed && !extractFailure && topicCount === 0 && !filesProcessing
  usePolling(() => router.refresh(), { active: waitingForJob, intervalMs: 4000, maxPolls: 15 })

  // Every state below sits in the same frame, tall enough for the tallest (a line and a button), so
  // the step under it does not move when the state changes from waiting to topics found.
  const frame = 'mt-3 min-h-24'

  if (extraction.running || extraction.failed) {
    return (
      <div className={`${frame} rounded-control bg-surface-2 px-3.5 py-3`}>
        <JobStatus
          job={extraction.job}
          label="Finding topics"
          since={extraction.since}
          timedOut={extraction.timedOut}
          onRetry={extraction.start}
          retrying={extraction.starting}
        />
      </div>
    )
  }

  if (topicCount > 0) {
    // "Found" counts only topics from the files; hand-added ones read as added. A failed search for
    // topics stays in view next to a list made by hand.
    const next = topics.unconfirmed > 0 ? 'Rename, merge or remove any, then confirm.' : 'Add any others, then confirm.'
    return (
      <div ref={foundRef} className={`${frame} flex flex-col gap-3`}>
        {failureAlert}
        <div role="status">
          <p className="text-small text-fg-2">
            {topicOriginSentence(topics)} {next}
          </p>
          {topicPreview.length > 0 ? (
            // The first names, so the list can be judged before opening the editor.
            <ul aria-label="Topics found" className="mt-2 flex flex-col gap-0.5 text-small text-fg">
              {topicPreview.map((name) => (
                <li key={name} className="flex min-w-0 gap-2">
                  <span aria-hidden="true" className="text-fg-3">&bull;</span>
                  <span className="min-w-0 wrap-anywhere">{name}</span>
                </li>
              ))}
              {topicCount > topicPreview.length ? <li className="pl-4 text-fg-2">+{topicCount - topicPreview.length} more</li> : null}
            </ul>
          ) : null}
          <Button asChild variant="primary" className="mt-3">
            <Link href={editHref}>{label}</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (filesProcessing) {
    return (
      <div className={frame}>
        <p className="text-small text-fg-2">
          Waiting for your files: <span className="tabular">{filesRead}</span> of <span className="tabular">{filesTotal}</span> read.
          Topics are found as soon as the last one is.
        </p>
      </div>
    )
  }

  if (failureAlert) {
    // The alert holds the retry; the other way on is to write the list by hand.
    return (
      <div className={`${frame} flex flex-col gap-3`}>
        {failureAlert}
        <div>
          <Button asChild variant="secondary">
            <Link href={editHref}>Add topics yourself</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={frame}>
      <p className="text-small text-fg-2">Margins reads your files and suggests a topic list.</p>
      <Button variant="primary" className="mt-3" onClick={extraction.start} loading={extraction.starting} disabled={!!extraction.blocked}>
        Find topics
      </Button>
      <AiBlockedNote className="mt-2" />
    </div>
  )
}

/**
 * Step 3 content: a link to the first topic. Content is written when a topic is opened, so there
 * is nothing to build here; the progress shows while the first topic is being written.
 */
export function StartStudyingStep({
  courseId,
  firstTopic,
  generation,
  plan,
}: {
  courseId: string
  firstTopic: { id: string; name: string } | null
  generation: GenerationState
  /** The date question and the daily time. While the date is still to be asked the step is one form; otherwise one link. */
  plan: { askForExamDate: boolean; dailyMinutes: number }
}) {
  const { active, readyNow, total, refresh } = useGenerationProgress(courseId, generation)
  const startHref = firstTopic ? `/courses/${courseId}/topics/${firstTopic.id}` : `/courses/${courseId}/topics`

  return (
    <div className="mt-3 flex flex-col gap-3">
      {active > 0 ? <GenerationProgress readyNow={readyNow} total={total} /> : null}
      <FailureList failures={generation.failures} onRetried={refresh} />
      {plan.askForExamDate ? (
        // One form with one primary action: the date (optional), the time, and the first topic.
        <SetupStartForm courseId={courseId} dailyMinutes={plan.dailyMinutes} startHref={startHref} firstTopicName={firstTopic?.name ?? null} />
      ) : (
        <Button asChild variant="primary" className="self-start">
          <Link href={startHref}>{firstTopic ? `Start warm-up: ${firstTopic.name}` : 'Open topics'}</Link>
        </Button>
      )}
      <p className="text-caption font-normal text-fg-3">
        {firstTopic
          ? 'A warm-up is a few questions you try before reading. A topic is prepared when you open it, which takes about a minute.'
          : 'A topic is prepared when you open it, which takes about a minute.'}
      </p>
    </div>
  )
}
