'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { JobStatus } from '@/components/ui/job-status'
import { toast } from '@/components/ui/toaster'
import { useAiStatus } from '@/features/ai/ai-status'
import { useJob } from '@/features/jobs/use-job'
import { apiFetch, isApiError } from '@/lib/api/client'
import { pluralize } from '@/lib/format'
import type { JobRef } from '@/server/queries/course'

/**
 * Follows topic finding for a course: the job the server saw running (so it resumes after a
 * refresh), or one this page starts. When it ends the page refreshes with the new topics.
 */
export function useExtraction(courseId: string, initial: JobRef | null) {
  const router = useRouter()
  const [started, setStarted] = React.useState<{ id: string; since: string } | null>(null)
  const [starting, setStarting] = React.useState(false)
  const { blocked, report } = useAiStatus()
  const jobId = started?.id ?? initial?.id ?? null
  const since = started?.since ?? initial?.createdAt ?? null
  const { job, timedOut } = useJob(jobId, { timeoutMs: 240_000, onSettled: () => router.refresh() })

  const start = React.useCallback(async () => {
    if (blocked) {
      // The button should be off already; say why rather than send a request that is refused.
      toast.error(blocked.text)
      return
    }
    setStarting(true)
    try {
      const result = await apiFetch<{ jobId: string }>(`/api/projects/${courseId}/extract-topics`, { method: 'POST' })
      setStarted({ id: result.jobId, since: new Date().toISOString() })
      router.refresh()
    } catch (error) {
      if (isApiError(error)) report(error.code)
      toast.error(isApiError(error) ? error.message : "Couldn't start finding topics. Try again.")
    } finally {
      setStarting(false)
    }
  }, [courseId, router, blocked, report])

  const running = !!jobId && job?.status !== 'completed' && job?.status !== 'failed'
  const failed = job?.status === 'failed' ? job : null
  // `blocked`: AI is unavailable or the allowance is used; Find topics buttons should be off, with
  // blocked.text beside them.
  return { jobId, job, since, timedOut, running, failed, starting, start, blocked }
}

type ExtractionBannerProps = {
  courseId: string
  extractJob: JobRef | null
  extractFailure: string | null
  topicCount: number
  /** Topics exist that the student has not confirmed yet. */
  unconfirmed: boolean
  /** Every file has been read. */
  filesReady: boolean
}

/** The Materials page banner: topics being found, failed, or ready to review. */
export function ExtractionBanner({
  courseId,
  extractJob,
  extractFailure,
  topicCount,
  unconfirmed,
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
  if (filesReady && topicCount > 0 && unconfirmed) {
    return (
      <InlineAlert
        tone="accent"
        title={`${pluralize(topicCount, 'topic')} found`}
        action={
          <Button asChild size="sm" variant="primary">
            <Link href={`/courses/${courseId}/topics?edit=1`}>Review topics</Link>
          </Button>
        }
      >
        Check the list before Margins builds your study content.
      </InlineAlert>
    )
  }
  return null
}
