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
import { autoStartDecision, autoStartRequest, prefetchRequest } from './auto-start'
import { KIND_COPY } from './copy'
import { CONTENT_KINDS, CONTENT_TYPE_BY_KIND, KIND_BY_CONTENT_TYPE, PREPARATION_TYPES, type ContentKind } from './types'
import type { GenerateMode } from './generate-preferences'
import { noticeForCode, type GenerationNotice } from './notice'
import { useTopicView } from './use-topic-view'
import { useShellAttempt } from '@/components/shell/shell-provider'

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
  generate: (
    kind: ContentKind,
    mode: GenerateMode,
    preferences: Record<string, unknown>,
    contentType?: string
  ) => Promise<boolean>
  /** Start a fresh review quiz set (focused on what was missed, with a prerequisite question or two). */
  generateReview: () => Promise<boolean>
  dismiss: (kind: ContentKind) => void
  /** Start the next topic's notes in the background (when this topic is marked done). */
  prefetchNext: () => void
  /** A quiz is being taken: the number keys pick options and [ ] stay still, and Ask, the tools and the topic arrows are put away (the quiz is a focus view, like the mock exam). */
  keysSuspended: boolean
  setKeysSuspended: (suspended: boolean) => void
  /** The student is in the middle of an activity on this view (a quiz being taken, a practice problem under way). */
  inProgress: boolean
  /** Counts one more view as working; the returned function takes it back. See useActivityInProgress. */
  claimInProgress: () => () => void
  /** An attempt is open on screen (a warm-up question, a recall answer, a practice problem, a quiz): on a phone the topic's header and path give way to a small bar. Null when none. */
  attempt: AttemptInfo | null
  /** Registers an attempt; the returned function takes it back. See useAttemptFocus. */
  claimAttempt: (info: AttemptInfo) => () => void
}

/** What the compact bar shows while an attempt is open: where Exit goes, or what it does instead of leaving the page. */
export type AttemptInfo = {
  /** Where Exit goes; the topics list when left out. */
  exitHref?: string
  /** Runs instead of leaving (the quiz asks first whether to save), when the page itself must answer. */
  onExit?: () => void
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

/**
 * Marks the view on screen as an activity the student is in the middle of while `active` is true. The
 * next-activity card steps aside meanwhile (it would pull them out of the work), and comes back, with the
 * refreshed next activity, once they are done. Each caller holds its own claim, so a view and a screen inside
 * it (the warm-up and its results) cannot switch each other off: effects run child first, and a flag the
 * parent wrote last used to win.
 */
export function useActivityInProgress(active: boolean) {
  const { claimInProgress } = useTopic()
  React.useEffect(() => (active ? claimInProgress() : undefined), [active, claimInProgress])
}

/**
 * Marks the view on screen as an attempt in progress while `active` is true, like the mock exam's and the review's focus
 * views: on a phone the topic header, its status line and the five-step path give way to one small bar (identity, Exit),
 * so the task and its next action sit on the first screen. A wide screen keeps the path. Outside the topic page (the map's
 * teach-back uses the recall card) it does nothing. `onExit` is read when Exit is pressed, so it may change between renders.
 */
export function useAttemptFocus(active: boolean, options: { exitHref?: string; onExit?: () => void } = {}) {
  const topic = useOptionalTopic()
  const claim = topic?.claimAttempt
  const onExit = React.useRef(options.onExit)
  React.useEffect(() => {
    onExit.current = options.onExit
  })
  const exitHref = options.exitHref
  const hasExit = !!options.onExit
  React.useEffect(() => {
    if (!active || !claim) return undefined
    return claim({ exitHref, onExit: hasExit ? () => onExit.current?.() : undefined })
  }, [active, claim, exitHref, hasExit])
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
  const [claims, setClaims] = React.useState(0)
  const inProgress = claims > 0
  const claimInProgress = React.useCallback(() => {
    setClaims((count) => count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      setClaims((count) => count - 1)
    }
  }, [])
  const [attempts, setAttempts] = React.useState<{ id: number; info: AttemptInfo }[]>([])
  const attemptIds = React.useRef(0)
  const attempt = attempts.length > 0 ? attempts[attempts.length - 1].info : null
  const claimAttempt = React.useCallback((info: AttemptInfo) => {
    const id = ++attemptIds.current
    setAttempts((current) => [...current, { id, info }])
    return () => setAttempts((current) => current.filter((item) => item.id !== id))
  }, [])
  // The app's own top bar and course tabs give way while an attempt is open, so the attempt bar is the only chrome on a phone.
  useShellAttempt(attempt !== null)
  const tracked = React.useRef(new Set<string>())
  // Opening a topic with no notes (and no failed attempt to retry by hand) starts its preparation once:
  // concepts, then the rest of the chain, notes among it.
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
    (jobId: string, kind: ContentKind, since: number, quiet = false, preparation = false) => {
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
          if (!quiet && !preparation) toast.success(KIND_COPY[kind].ready)
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
        if (preparation) {
          // Concepts and the warm-up are extras: the AI service goes on to write the notes.
          void syncActiveRef.current(true)
          return
        }
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
        const preparation = PREPARATION_TYPES.includes(target.contentType)
        const kind = preparation ? 'notes' : KIND_BY_CONTENT_TYPE[target.contentType]
        if (!kind) continue
        const startedAt = Date.parse(String(job.raw.startedAt ?? job.raw.createdAt ?? ''))
        track(job.id, kind, Number.isFinite(startedAt) ? startedAt : Date.now(), quiet, preparation)
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
    async (kind, mode, preferences, contentType = CONTENT_TYPE_BY_KIND[kind]) => {
      setStarting((current) => ({ ...current, [kind]: true }))
      setStartError((current) => ({ ...current, [kind]: undefined }))
      setLocalFailure((current) => ({ ...current, [kind]: undefined }))
      setDismissed((current) => [...current.filter((item) => item !== kind), kind])
      try {
        const endpoint = mode === 'create' ? 'generate-content' : 'regenerate-content'
        const response = await apiFetch<{ jobId: string | null; contentType?: string }>(`/api/topics/${topicId}/${endpoint}`, {
          method: 'POST',
          json: { contentType, preferences },
        })
        // The server may start a later type than the one asked for (a topic that has its concepts already).
        const started = response.contentType ?? contentType
        if (response.jobId) track(response.jobId, kind, Date.now(), false, PREPARATION_TYPES.includes(started))
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

  // Start the preparation of a topic that has no notes, once the jobs already running have been found.
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
    const request = autoStartRequest()
    void generate('notes', 'create', request.preferences, request.contentType).finally(() => setPreparingNotes(false))
  }, [preparingNotes, activeChecked, notesPresent, notesRunning, blocked, generate])

  const prefetchNext = React.useCallback(() => {
    if (!next || next.hasNotes) return
    // Quiet: it is a head start, and a failure shows when that topic is opened.
    apiFetch(`/api/topics/${next.id}/generate-content`, { method: 'POST', json: prefetchRequest() }).catch(() => {})
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
      inProgress,
      claimInProgress,
      attempt,
      claimAttempt,
    }),
    [topicId, courseId, running, startError, failure, starting, preparingNotes, generate, generateReview, dismiss, prefetchNext, keysSuspended, inProgress, claimInProgress, attempt, claimAttempt]
  )

  // `data-attempt` lets the topic's chrome (header, path, panel spacing) step aside on a phone with plain CSS
  // (`group-data-[attempt]/topic:`), without each piece needing the state; `contents` keeps the wrapper out of the layout.
  return (
    <TopicContext.Provider value={value}>
      <div data-attempt={attempt ? '' : undefined} className="group/topic contents">
        {children}
      </div>
    </TopicContext.Provider>
  )
}
