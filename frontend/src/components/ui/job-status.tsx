'use client'

import * as React from 'react'
import { CheckCircle, Info, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { useAiStatus } from '@/features/ai/ai-status'
import { fillResetTime } from '@/lib/budget/copy'
import { describeJobFailure } from '@/lib/jobs/failure-message'
import { formatElapsed } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Progress } from './progress'
import { Spinner } from './spinner'

export const STAGE_LABELS: Record<string, string> = {
  pending: 'Waiting to start',
  retrying: 'Trying again',
  waiting_for_ai: 'Waiting for AI to be available',
  validating: 'Checking the file',
  chunking: 'Reading pages',
  embedding: 'Indexing for search',
  extracting: 'Finding topics',
  generating: 'Writing',
  saving: 'Saving',
  grading: 'Grading answers',
}

/**
 * The words for a job stage, or a neutral fallback for one we do not know. A queued job that has
 * already run is waiting for its retry (the AI service puts it back after a passing failure).
 */
export function stageLabel(stage: string | null | undefined, status?: string, attemptCount?: number): string {
  if (status === 'queued' || status === 'pending') {
    if (stage === 'waiting_for_ai') return STAGE_LABELS.waiting_for_ai
    return attemptCount && attemptCount > 0 ? STAGE_LABELS.retrying : STAGE_LABELS.pending
  }
  return (stage && STAGE_LABELS[stage]) || 'Working on it'
}

/** The parts of a job this component reads (a NormalizedJob satisfies it). */
export type JobStatusJob = {
  status: 'queued' | 'processing' | 'completed' | 'failed'
  stage?: string | null
  progressPercent?: number
  errorCode?: string | null
  errorMessage?: string | null
  retryable?: boolean
  attemptCount?: number
  jobType?: string
}

export const TIMEOUT_NOTE = 'Still working in the background. You can leave this page.'

type JobStatusProps = {
  job: JobStatusJob | null
  /** Replaces the stage words, e.g. "Writing your exam". */
  label?: string
  /** When the work started, for the elapsed time. */
  since?: Date | string | number | null
  /** The poller gave up waiting; the job itself is still running. */
  timedOut?: boolean
  /** Shows "Try again" on a retryable failure. */
  onRetry?: () => void
  retrying?: boolean
  showProgress?: boolean
  className?: string
}

const subscribeToClock = (callback: () => void) => {
  const timer = setInterval(callback, 1000)
  return () => clearInterval(timer)
}

/** Seconds since `since`, ticking once a second while `running`. Null on the server. */
export function useElapsed(since: JobStatusProps['since'], running: boolean): number | null {
  const second = React.useSyncExternalStore(
    running ? subscribeToClock : () => () => {},
    () => Math.floor(Date.now() / 1000),
    () => null
  )
  if (!running || since === null || since === undefined || second === null) return null
  return Math.max(0, second - new Date(since).getTime() / 1000)
}

/** The one way to show a background job. Announces changes politely. */
export function JobStatus({
  job,
  label,
  since,
  timedOut,
  onRetry,
  retrying,
  showProgress = true,
  className,
}: JobStatusProps) {
  const running = !job || job.status === 'queued' || job.status === 'processing'
  const elapsed = useElapsed(since, running && !timedOut)
  const { blocked } = useAiStatus()

  let icon: React.ReactNode
  let text: React.ReactNode
  let meta: React.ReactNode = null
  let progress: React.ReactNode = null
  let action: React.ReactNode = null

  if (job?.status === 'failed') {
    icon = <WarningCircle aria-hidden="true" className="size-4 shrink-0 text-danger" />
    text = fillResetTime(describeJobFailure(job.errorCode, job.errorMessage, job.jobType))
    // Not while AI is unavailable or the allowance is used: the banner or the note says why.
    if (job.retryable !== false && onRetry && !blocked) {
      action = (
        <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      )
    }
  } else if (job?.status === 'completed') {
    icon = <CheckCircle aria-hidden="true" weight="fill" className="size-4 shrink-0 text-accent" />
    text = label ?? 'Done'
  } else if (timedOut) {
    icon = <Info aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
    text = <span className="font-normal text-fg-2">{TIMEOUT_NOTE}</span>
  } else {
    icon = <Spinner className="text-accent" />
    text =
      job?.status === 'queued' && (job.attemptCount || job.stage === 'waiting_for_ai')
        ? stageLabel(job.stage, job.status, job.attemptCount)
        : (label ?? stageLabel(job?.stage, job?.status ?? 'queued'))
    if (elapsed !== null) {
      meta = (
        <span aria-hidden="true" className="tabular text-caption font-normal text-fg-3">
          {formatElapsed(elapsed)}
        </span>
      )
    }
    if (showProgress) {
      const percent = job?.progressPercent ?? 0
      progress = (
        <Progress
          aria-label={typeof text === 'string' ? text : 'Progress'}
          className="mt-2.5"
          indeterminate={!job || job.status === 'queued' || percent <= 10 || percent >= 100}
          value={percent}
        />
      )
    }
  }

  return (
    <div aria-live="polite" className={cn('w-full', className)}>
      <div className="flex items-center gap-2.5">
        {icon}
        <p className="min-w-0 flex-1 text-body-strong text-fg">{text}</p>
        {meta}
        {action}
      </div>
      {progress}
    </div>
  )
}
