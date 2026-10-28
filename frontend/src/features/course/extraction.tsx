'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { JobStatus } from '@/components/ui/job-status'
import { toast } from '@/components/ui/toaster'
import { useJob } from '@/features/jobs/use-job'
import { apiFetch, isApiError } from '@/lib/api/client'
import { needsTopicReview, topicOriginSentence, type CourseSetup } from '@/lib/course-setup'
import type { JobRef } from '@/server/queries/course'

/**
 * Follows topic finding for a course: the job the server saw running (so it resumes after a
 * refresh), or one this page starts. When it ends the page refreshes with the new topics.
 */
export function useExtraction(courseId: string, initial: JobRef | null) {
  const router = useRouter()
  const [started, setStarted] = React.useState<{ id: string; since: string } | null>(null)
  const [starting, setStarting] = React.useState(false)
  const jobId = started?.id ?? initial?.id ?? null
  const since = started?.since ?? initial?.createdAt ?? null
  const { job, timedOut } = useJob(jobId, { timeoutMs: 240_000, onSettled: () => router.refresh() })

  const start = React.useCallback(async () => {
    setStarting(true)
    try {
      const result = await apiFetch<{ jobId: string }>(`/api/projects/${courseId}/extract-topics`, { method: 'POST' })
      setStarted({ id: result.jobId, since: new Date().toISOString() })
      router.refresh()
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't start finding topics. Try again.")
    } finally {
      setStarting(false)
    }
  }, [courseId, router])

  const running = !!jobId && job?.status !== 'completed' && job?.status !== 'failed'
  const failed = job?.status === 'failed' ? job : null
  return { jobId, job, since, timedOut, running, failed, starting, start }
}

type ExtractionBannerProps = {
  courseId: string
  extractJob: JobRef | null
  extractFailure: string | null
  /** The course's setup state (lib/course-setup.ts). */
  setup: CourseSetup
  /** Every file has been read. */
  filesReady: boolean
}

/** The Materials page banner: topics being found, failed, or waiting for the student to confirm. */
export function ExtractionBanner({
  courseId,
  extractJob,
  extractFailure,
  setup,
  filesReady,
}: ExtractionBannerProps) {
  const extraction = useExtraction(courseId, extractJob)

  if (extraction.running || extraction.failed) {
    return (
      <div className="rounded-control bg-surface-2 px-3.5 py-3">
        <JobStatus
          job={extraction.job}
          label="Finding topics in your files"
          since={extraction.since}
          timedOut={extraction.timedOut}
          onRetry={extraction.start}
          retrying={extraction.starting}
        />
      </div>
    )
  }
  if (extractFailure) {
    return (
      <InlineAlert
        tone="danger"
        title="We couldn't find topics"
        action={
          <Button size="sm" variant="secondary" onClick={extraction.start} loading={extraction.starting}>
            Try again
          </Button>
        }
      >
        {extractFailure}
      </InlineAlert>
    )
  }
  if (filesReady && needsTopicReview(setup) && setup.mode === 'setup') {
    return (
      <InlineAlert
        tone="accent"
        title={topicOriginSentence(setup.topics)}
        action={
          <Button asChild size="sm" variant="primary">
            <Link href={`/courses/${courseId}/topics?edit=1`}>{setup.label}</Link>
          </Button>
        }
      >
        Check the list before Margins builds your study content.
      </InlineAlert>
    )
  }
  return null
}
