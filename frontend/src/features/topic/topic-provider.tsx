'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'
import { track as trackEvent } from '@/lib/analytics/track'
import { isKnownAiCode } from '@/lib/ai/messages'
import { fillResetTime } from '@/lib/budget/copy'
import { parseContentTarget } from '@/lib/jobs/failure-message'
import { fetchActiveJobs, type NormalizedJob } from '@/lib/jobs/poll-job'
import { useAiStatus } from '@/features/ai/ai-status'
import { useJobPolling } from '@/features/jobs/use-job-polling'
import { autoStartDecision } from './auto-start'
import { KIND_COPY } from './copy'
import { CONTENT_KINDS, CONTENT_TYPE_BY_KIND, KIND_BY_CONTENT_TYPE, type ContentKind } from './types'
import type { GenerateMode } from './generate-preferences'
import { noticeForCode, type GenerationNotice } from './notice'
import { useTopicView } from './use-topic-view'

export type { GenerationNotice } from './notice'

export type RunningJob = {
  jobId: string
  job: NormalizedJob | null
  /** Epoch ms the work started, for the elapsed time. */
  since: number
  /** The poller stopped waiting; the job is still running on the server. */
  timedOut: boolean
  /** The job finished and the page is waiting for the refreshed content to arrive. */
  done: boolean
}

type TopicContextValue = {
  topicId: string
  courseId: string
  running: Partial<Record<ContentKind, RunningJob>>
  /** A failure to start a job (AI unavailable, daily budget) by kind. */
  startError: Partial<Record<ContentKind, GenerationNotice>>
  /** The latest job for this kind failed (from the server, or while this page was open). */
  failure: Partial<Record<ContentKind, GenerationNotice>>
  starting: Partial<Record<ContentKind, boolean>>
  /** Opening a topic with no notes starts them; true until that has started (or been found running). */
  preparingNotes: boolean
  generate: (kind: ContentKind, mode: GenerateMode, preferences: Record<string, unknown>) => Promise<boolean>
  /** Start a fresh review quiz set (focused on what was missed, with a prerequisite question or two). */
  generateReview: () => Promise<boolean>
  dismiss: (kind: ContentKind) => void
  /** Start the next topic's notes in the background (when this topic is marked done). */
  prefetchNext: () => void
  /** The number keys switch views, except while a quiz is being taken (they pick options). */
  keysSuspended: boolean
  setKeysSuspended: (suspended: boolean) => void
}

const TopicContext = React.createContext<TopicContextValue | null>(null)

/** The topic context, or null outside the topic page (the review list uses the same buttons). */
export function useOptionalTopic(): TopicContextValue | null {
  return React.useContext(TopicContext)
}

export function useTopic(): TopicContextValue {
  const value = React.useContext(TopicContext)
  if (!value) throw new Error('useTopic must be used inside TopicProvider')
  return value
}

/** Generation state of one kind of content, with the action to start it. */
export function useGeneration(kind: ContentKind) {
  const topic = useTopic()
  return {
    running: topic.running[kind],
    failure: topic.failure[kind],
    startError: topic.startError[kind],
    starting: !!topic.starting[kind],
    preparing: kind === 'notes' && topic.preparingNotes,
    generate: (mode: GenerateMode, preferences: Record<string, unknown>) =>
      topic.generate(kind, mode, preferences),
    dismiss: () => topic.dismiss(kind),
  }
}

/** A refused start: the shared words for a known code, else what the route said. */
function toNotice(error: unknown): GenerationNotice {
  if (isApiError(error)) {
    if (isKnownAiCode(error.code)) {
      const notice = noticeForCode(error.code)
      return { ...notice, message: fillResetTime(notice.message) }
    }
    // error.message is already filled in by apiFetch.
    return { message: error.message, tone: 'danger', retry: true }
  }
  return { message: 'Something went wrong. Try again.', tone: 'danger', retry: true }
}

const failureNotice = (job: NormalizedJob): GenerationNotice => {
  const notice = noticeForCode(job.errorCode, job.retryable)
  return { ...notice, message: fillResetTime(notice.message) }
}

const JOB_TIMEOUT_MS = 180_000

type ProviderProps = {
  topicId: string
  courseId: string
  /** Changes when any content is rewritten (the refresh has landed). */
  contentVersion: string
  /** Failures the server found for kinds that still have no content. */
  initialFailures: Partial<Record<ContentKind, GenerationNotice>>
  /** Whether the topic has notes when the page is rendered. */
  notesPresent: boolean
  /** The next topic in course order, whose notes are started when this one is marked done. */
  next: { id: string; hasNotes: boolean } | null
  children: React.ReactNode
}

/**
 * Everything on the topic page that outlives a view: background generation (started here or
 * found running after a refresh), its failures, and the keyboard lock for the quiz.
 *
 * Content is written on demand. Opening a topic with no notes starts them (one job, once: a
 * refresh finds the job that is already running, and the server allows one job per topic and
 * type); the AI service then queues the other types one after another, and this provider follows
 * each of those jobs as it appears.
 *
 * A running job is followed with the shared poller. When it completes the page is refreshed
 * (the content is read on the server) and a quiet toast says it is ready; the "generating"
 * state stays up until the new content has arrived, so the view never flashes empty.
 */
export function TopicProvider({
  topicId,
  courseId,
  contentVersion,
  initialFailures,
  notesPresent,
  next,
  children,
}: ProviderProps) {
  const router = useRouter()
  const { pollJob } = useJobPolling({ timeoutMs: JOB_TIMEOUT_MS })
  const { blocked, report } = useAiStatus()
  // The view on screen: a failure there shows in the view itself, so it gets no toast.
  const view = useTopicView()
  const viewRef = React.useRef(view)
  React.useEffect(() => {
    viewRef.current = view
  })
  const [running, setRunning] = React.useState<TopicContextValue['running']>({})
  const [startError, setStartError] = React.useState<TopicContextValue['startError']>({})
  const [localFailure, setLocalFailure] = React.useState<TopicContextValue['failure']>({})
  const [starting, setStarting] = React.useState<TopicContextValue['starting']>({})
  const [keysSuspended, setKeysSuspended] = React.useState(false)
  const tracked = React.useRef(new Set<string>())
  // Opening a topic with no notes (and no failed attempt to retry by hand) starts them once.
  const [preparingNotes, setPreparingNotes] = React.useState(!notesPresent && !initialFailures.notes)
  const [activeChecked, setActiveChecked] = React.useState(false)
  const autoStarted = React.useRef(false)

  // Failures from the server hold until a new run starts; ones seen here replace them.
  const [dismissed, setDismissed] = React.useState<ContentKind[]>([])
  const failure = React.useMemo(() => {
    const merged: TopicContextValue['failure'] = {}
    for (const kind of CONTENT_KINDS) {
      const notice = localFailure[kind] ?? (dismissed.includes(kind) ? undefined : initialFailures[kind])
      if (notice) merged[kind] = notice
    }
    return merged
  }, [localFailure, initialFailures, dismissed])

  const track = React.useCallback(
    (jobId: string, kind: ContentKind, since: number, quiet = false) => {
      if (tracked.current.has(jobId)) return
      tracked.current.add(jobId)
      setRunning((current) => ({ ...current, [kind]: { jobId, job: null, since, timedOut: false, done: false } }))

      void pollJob(jobId, (job) => {
        setRunning((current) =>
          current[kind]?.jobId === jobId ? { ...current, [kind]: { ...current[kind]!, job } } : current
        )
      }).then((result) => {
        if (result.state === 'cancelled') return
        if (result.state === 'completed') {
          setRunning((current) =>
            current[kind]?.jobId === jobId ? { ...current, [kind]: { ...current[kind]!, done: true } } : current
          )
          if (kind === 'notes') trackEvent('notes_generated')
          if (!quiet) toast.success(KIND_COPY[kind].ready)
          // The AI service has already created the job for the next type, if it queues one.
          void syncActiveRef.current(true)
          React.startTransition(() => router.refresh())
          return
        }
        if (result.state === 'timeout') {
          setRunning((current) =>
            current[kind]?.jobId === jobId ? { ...current, [kind]: { ...current[kind]!, timedOut: true } } : current
          )
          return
        }
        // Failed.
        setRunning((current) => {
          if (current[kind]?.jobId !== jobId) return current
          const next = { ...current }
          delete next[kind]
          return next
        })
        report(result.job?.errorCode)
        const notice = result.job ? failureNotice(result.job) : noticeForCode(null)
        setLocalFailure((current) => ({ ...current, [kind]: notice }))
        // Only for a failure in another view of this topic: this one shows it in place.
        if (viewRef.current !== kind) {
          toast.error(`${KIND_COPY[kind].failed}.${notice.retry ? ' Open it to try again.' : ''}`)
        }
      })
    },
    [pollJob, router, report]
  )

  // Follow this topic's jobs that are running on the server: ones started before this page
  // loaded, and (quietly) the next type in the chain after a job finishes.
  const syncActive = React.useCallback(
    async (quiet: boolean, signal?: AbortSignal) => {
      const jobs = await fetchActiveJobs({ projectId: courseId, jobTypes: ['generate_content'] }, signal)
      for (const job of jobs) {
        const targetKey = typeof job.raw.targetKey === 'string' ? job.raw.targetKey : null
        const target = parseContentTarget(targetKey)
        if (!target || target.topicId !== topicId) continue
        const kind = KIND_BY_CONTENT_TYPE[target.contentType]
        if (!kind) continue
        const startedAt = Date.parse(String(job.raw.startedAt ?? job.raw.createdAt ?? ''))
        track(job.id, kind, Number.isFinite(startedAt) ? startedAt : Date.now(), quiet)
      }
    },
    [courseId, topicId, track]
  )
  const syncActiveRef = React.useRef(syncActive)
  React.useEffect(() => {
    syncActiveRef.current = syncActive
  })

  React.useEffect(() => {
    const controller = new AbortController()
    syncActive(false, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setActiveChecked(true)
      })
    return () => controller.abort()
  }, [syncActive])

  // Fresh content has arrived: stop showing the finished jobs.
  React.useEffect(() => {
    setRunning((current) => {
      const entries = Object.entries(current).filter(([, value]) => !value?.done)
      return entries.length === Object.keys(current).length ? current : (Object.fromEntries(entries) as typeof current)
    })
  }, [contentVersion])

  // If the refresh never lands (offline, say), do not stay on "Done" forever.
  React.useEffect(() => {
    const finished = Object.values(running).some((value) => value?.done)
    if (!finished) return
    const timer = setTimeout(() => {
      setRunning((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => !value?.done)))
    }, 6000)
    return () => clearTimeout(timer)
  }, [running])

  const generate = React.useCallback<TopicContextValue['generate']>(
    async (kind, mode, preferences) => {
      setStarting((current) => ({ ...current, [kind]: true }))
      setStartError((current) => ({ ...current, [kind]: undefined }))
      setLocalFailure((current) => ({ ...current, [kind]: undefined }))
      setDismissed((current) => [...current.filter((item) => item !== kind), kind])
      try {
        const endpoint = mode === 'create' ? 'generate-content' : 'regenerate-content'
        const response = await apiFetch<{ jobId: string | null }>(`/api/topics/${topicId}/${endpoint}`, {
          method: 'POST',
          json: { contentType: CONTENT_TYPE_BY_KIND[kind], preferences },
        })
        if (response.jobId) track(response.jobId, kind, Date.now())
        // Nothing was started because the content is already there: show it.
        else React.startTransition(() => router.refresh())
        return true
      } catch (error) {
        if (isApiError(error)) report(error.code)
        setStartError((current) => ({ ...current, [kind]: toNotice(error) }))
        return false
      } finally {
        setStarting((current) => ({ ...current, [kind]: false }))
      }
    },
    [topicId, track, router, report]
  )

  // A job the address names (?job=, from "Fresh review" on the review page) is followed from the start, so a
  // set that was written before the page loaded still shows up.
  const namedJob = useSearchParams().get('job')
  React.useEffect(() => {
    if (namedJob) track(namedJob, 'quiz', Date.now(), true)
  }, [namedJob, track])

  const generateReview = React.useCallback<TopicContextValue['generateReview']>(async () => {
    const kind: ContentKind = 'quiz'
    setStarting((current) => ({ ...current, [kind]: true }))
    setStartError((current) => ({ ...current, [kind]: undefined }))
    setLocalFailure((current) => ({ ...current, [kind]: undefined }))
    setDismissed((current) => [...current.filter((item) => item !== kind), kind])
    try {
      const response = await apiFetch<{ jobId: string | null }>(`/api/topics/${topicId}/fresh-review`, { method: 'POST' })
      if (response.jobId) track(response.jobId, kind, Date.now())
      else React.startTransition(() => router.refresh())
      return true
    } catch (error) {
      if (isApiError(error)) report(error.code)
      setStartError((current) => ({ ...current, [kind]: toNotice(error) }))
      return false
    } finally {
      setStarting((current) => ({ ...current, [kind]: false }))
    }
  }, [topicId, track, router, report])

  // Start the notes of a topic that has none, once the jobs already running have been found.
  const notesRunning = !!running.notes
  React.useEffect(() => {
    const decision = autoStartDecision({
      preparing: preparingNotes,
      activeChecked,
      alreadyStarted: autoStarted.current,
      notesPresent,
      notesRunning,
      aiBlocked: !!blocked,
    })
    if (decision === 'wait') return
    if (decision === 'skip') {
      setPreparingNotes(false)
      return
    }
    autoStarted.current = true
    void generate('notes', 'create', { prepare_rest: true, only_if_missing: true }).finally(() => setPreparingNotes(false))
  }, [preparingNotes, activeChecked, notesPresent, notesRunning, blocked, generate])

  const prefetchNext = React.useCallback(() => {
    if (!next || next.hasNotes) return
    // Quiet: it is a head start, and a failure shows when that topic is opened.
    apiFetch(`/api/topics/${next.id}/generate-content`, {
      method: 'POST',
      json: { contentType: CONTENT_TYPE_BY_KIND.notes, preferences: { only_if_missing: true } },
    }).catch(() => {})
  }, [next])

  const dismiss = React.useCallback((kind: ContentKind) => {
    setStartError((current) => ({ ...current, [kind]: undefined }))
    setLocalFailure((current) => ({ ...current, [kind]: undefined }))
    setDismissed((current) => [...current.filter((item) => item !== kind), kind])
  }, [])

  const value = React.useMemo<TopicContextValue>(
    () => ({
      topicId,
      courseId,
      running,
      startError,
      failure,
      starting,
      preparingNotes,
      generate,
      generateReview,
      dismiss,
      prefetchNext,
      keysSuspended,
      setKeysSuspended,
    }),
    [topicId, courseId, running, startError, failure, starting, preparingNotes, generate, generateReview, dismiss, prefetchNext, keysSuspended]
  )

  return <TopicContext.Provider value={value}>{children}</TopicContext.Provider>
}
