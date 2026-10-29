'use client'

import * as React from 'react'
import { Exam, Lightbulb, Notebook, PencilSimpleLine } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { InlineAlert } from '@/components/ui/inline-alert'
import { JobStatus } from '@/components/ui/job-status'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { useResetTime } from '@/lib/budget/use-reset-time'
import { KIND_COPY } from './copy'
import { GenerateForm } from './generate-form'
import type { GenerateMode } from './generate-preferences'
import { ViewSkeleton } from './skeletons'
import { useGeneration } from './topic-provider'
import type { ContentKind } from './types'

const KIND_ICONS: Record<ContentKind, React.ReactNode> = {
  notes: <Notebook />,
  examples: <Lightbulb />,
  practice: <PencilSimpleLine />,
  quiz: <Exam />,
}

/** The options for one kind of content in a popover that closes once the job has started. */
export function GenerateOptions({
  kind,
  mode,
  submitLabel,
  note,
  focusPlaceholder,
  align = 'start',
  children,
}: {
  kind: ContentKind
  mode: GenerateMode
  submitLabel: string
  note?: React.ReactNode
  focusPlaceholder?: string
  align?: 'start' | 'center' | 'end'
  /** The trigger: a single button element. */
  children: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-80">
        <GenerateForm
          kind={kind}
          mode={mode}
          submitLabel={submitLabel}
          note={note}
          focusPlaceholder={focusPlaceholder}
          onStarted={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Regenerate from the overflow menu: the same options in a small dialog. */
export function RegenerateDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: ContentKind
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const copy = KIND_COPY[kind]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{copy.regenerate}</DialogTitle>
          <DialogDescription>{copy.replaces}</DialogDescription>
        </DialogHeader>
        <GenerateForm
          kind={kind}
          mode="regenerate"
          submitLabel={copy.regenerate}
          onStarted={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The notice for a failed or refused job, with its actions. */
function FailureAlert({
  kind,
  message,
  tone,
  action,
}: {
  kind: ContentKind
  message: string
  tone: 'danger' | 'warning'
  action?: React.ReactNode
}) {
  const text = useResetTime(message)
  return (
    <InlineAlert tone={tone} title={KIND_COPY[kind].failed} action={action}>
      {text}
    </InlineAlert>
  )
}

type ContentGateProps = {
  kind: ContentKind
  topicName: string
  /** Whether this kind of content exists. */
  present: boolean
  children: React.ReactNode
}

/**
 * Wraps a view with everything about its content being missing, being written or having
 * failed. With content present it shows the view, plus a status line while a replacement or
 * an addition is being written. Without it: the empty state, the generating state (a job
 * status and a skeleton of the final layout; also while a just-opened topic's notes are being
 * started) or the failure. A failure is shown once, as an alert with its actions, in place of
 * the empty state (the page sends no toast for the view on screen).
 */
export function ContentGate({ kind, topicName, present, children }: ContentGateProps) {
  const { running, failure, startError, starting, preparing, generate } = useGeneration(kind)
  const { blocked } = useAiStatus()
  const copy = KIND_COPY[kind]

  const status = running ? (
    <JobStatus
      job={running.job ?? { status: running.done ? 'completed' : 'queued' }}
      label={running.done ? copy.ready : undefined}
      since={running.since}
      timedOut={running.timedOut}
      showProgress={!running.done}
    />
  ) : null

  const retry = () => generate('create', {})

  if (present) {
    return (
      <div className="flex flex-col gap-6">
        {status ? <div className="rounded-control bg-surface-2 px-3.5 py-3">{status}</div> : null}
        {!running && startError ? <FailureAlert kind={kind} message={startError.message} tone={startError.tone} /> : null}
        {!running && !startError && failure ? (
          <FailureAlert kind={kind} message={failure.message} tone={failure.tone} />
        ) : null}
        {children}
      </div>
    )
  }

  // Opening a topic starts its notes: show the generating state from the first paint, not the
  // empty state for the moment before the job exists.
  if (running || (preparing && !startError && !failure)) {
    return (
      <div className="flex flex-col gap-8" aria-busy="true">
        <div className="max-w-[720px]">
          {status ?? <JobStatus job={{ status: 'queued' }} showProgress />}
        </div>
        <ViewSkeleton kind={kind} />
      </div>
    )
  }

  const notice = startError ?? failure
  if (notice) {
    // Try again only when it may work now; Options stays for a retry with different settings.
    const canRetry = notice.retry && !blocked
    return (
      <div className="max-w-[720px]">
        <FailureAlert
          kind={kind}
          message={notice.message}
          tone={notice.tone}
          action={
            <div className="flex items-center gap-1">
              {canRetry ? (
                <Button size="sm" variant="secondary" onClick={retry} loading={starting}>
                  Try again
                </Button>
              ) : null}
              {blocked ? null : (
                <GenerateOptions kind={kind} mode="create" submitLabel={copy.create} align="end">
                  <Button size="sm" variant="ghost">
                    Options
                  </Button>
                </GenerateOptions>
              )}
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <EmptyState
        icon={KIND_ICONS[kind]}
        title={copy.emptyTitle}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button variant="primary" loading={starting} disabled={!!blocked} onClick={retry}>
              {copy.create}
            </Button>
            <AiBlockedNote className="max-w-[40ch] text-center" />
          </div>
        }
        secondary={
          <GenerateOptions kind={kind} mode="create" submitLabel={copy.create}>
            <Button variant="link" className="text-small">
              Options
            </Button>
          </GenerateOptions>
        }
      >
        Written from your materials for {topicName}. Takes about a minute.
      </EmptyState>
    </div>
  )
}
