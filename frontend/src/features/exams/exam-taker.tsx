'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Clock, Flag, SquaresFour } from '@phosphor-icons/react/dist/ssr'
import { FocusHeader, useFocusExitGuard } from '@/components/shell/slots'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from '@/components/ui/toaster'
import type { ConfidenceId } from '@/lib/learning/calibration'
import { QuestionNavigator } from '@/components/learning/question-navigator'
import { ConfidenceRow, optionCountOf } from '@/features/topic/quiz-confidence'
import { apiFetch, isApiError } from '@/lib/api/client'
import type { AttemptView } from '@/lib/exams/attempts'
import { formatClock } from '@/lib/format'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { useQuestionMotion } from '@/lib/question-motion'
import { cn } from '@/lib/utils'
import { joinAnswers, splitAnswers, submitSummary } from './exam-answers'
import { parseFlagState, timeNotice, timerTone, type FlagState } from './exam-timer'
import { useExamAutosave, type SaveStatus } from './use-exam-autosave'
import { useSessionValue } from './use-session-value'

export type ExamTakerProps = {
  courseId: string
  examId: string
  title: string
  questions: PublicQuizQuestion[]
  attempt: AttemptView
}

const clientNow = () => Date.now()
const RESYNC_MS = 30_000

const subscribeToClock = (callback: () => void) => {
  const timer = setInterval(callback, 1000)
  return () => clearInterval(timer)
}

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving...',
  saved: 'Saved',
  error: 'Not saved',
}

/**
 * Whether the answers are safe, in the header on every screen size: a compact Saving or Saved, and when a save fails a
 * "Not saved" that says so and a Retry (the autosave also tries again by itself). A failure is never left out for want of room.
 */
function SaveState({ status, text, onRetry }: { status: SaveStatus; text: string; onRetry: () => void }) {
  if (status === 'error') {
    return (
      <span role="alert" className="flex shrink-0 items-center gap-1.5 text-caption text-warning-soft-fg sm:text-small" data-testid="exam-save-status">
        {text}
        <button type="button" onClick={onRetry} className="rounded-chip px-1.5 font-medium underline underline-offset-2 max-sm:min-h-11 max-sm:px-2">
          Retry
        </button>
      </span>
    )
  }
  return (
    <span aria-live="polite" className="shrink-0 text-right text-caption text-fg-3 sm:min-w-[6.5rem] sm:text-small" data-testid="exam-save-status">
      {text}
    </span>
  )
}

function Timer({ secondsLeft }: { secondsLeft: number }) {
  const tone = timerTone(secondsLeft)
  return (
    <span
      role="timer"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip px-2 py-1 font-mono text-[15px] leading-none tabular',
        tone === 'normal' && 'text-fg',
        tone === 'warning' && 'bg-warning-soft text-warning-soft-fg',
        tone === 'danger' && 'bg-danger-soft text-danger-soft-fg'
      )}
    >
      <Clock aria-hidden="true" className="size-4" />
      <span className="sr-only">Time left </span>
      {formatClock(secondsLeft)}
    </span>
  )
}

const isTypingTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** The exam: one question at a time, a server-timed countdown, autosave, flags and submit. */
export default function ExamTaker({ courseId, examId, title, questions, attempt }: ExamTakerProps) {
  const router = useRouter()
  const total = questions.length
  const base = `/courses/${courseId}/exams/${examId}`

  // Answers come back as strings, numbers or booleans, with a confidence inside once given; the form works in strings.
  const initial = React.useMemo(() => splitAnswers(attempt.answers), [attempt.answers])
  const [answers, setAnswers] = React.useState<Record<string, string>>(initial.answers)
  const [confidence, setConfidence] = React.useState<Record<string, number>>(initial.confidence)
  const [levels, setLevels] = React.useState<Record<string, ConfidenceId>>(initial.levels)
  // What is saved and submitted: the confidence travels inside each answer, so the autosave carries it.
  const stored = React.useMemo(() => joinAnswers(answers, confidence, levels), [answers, confidence, levels])
  const savedAnswers = React.useMemo(() => joinAnswers(initial.answers, initial.confidence, initial.levels), [initial])
  const storedRef = React.useRef(stored)
  React.useEffect(() => {
    storedRef.current = stored
  })

  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [confirmSubmit, setConfirmSubmit] = React.useState(false)
  const [confirmExit, setConfirmExit] = React.useState(false)
  const [navOpen, setNavOpen] = React.useState(false)
  const leavingRef = React.useRef(false)

  // Flags and the current question live in sessionStorage so a refresh keeps them.
  const [storedState, setStoredState] = useSessionValue(`margins-exam:${attempt.id}`)
  const { flags, position }: FlagState = React.useMemo(() => parseFlagState(storedState, total), [storedState, total])
  const flagged = React.useMemo(() => new Set(flags), [flags])
  const current = position
  const motion = useQuestionMotion(current)
  const question = questions[current]

  const answeredSet = React.useMemo(() => {
    const set = new Set<number>()
    for (let i = 0; i < total; i += 1) if ((answers[String(i)] ?? '').trim() !== '') set.add(i)
    return set
  }, [answers, total])
  const unanswered = total - answeredSet.size

  const goTo = React.useCallback(
    (index: number) => {
      const next = Math.min(Math.max(index, 0), total - 1)
      setStoredState(JSON.stringify({ flags, position: next }))
    },
    [flags, total, setStoredState]
  )
  const toggleFlag = () => {
    const next = flagged.has(current) ? flags.filter((n) => n !== current) : [...flags, current]
    setStoredState(JSON.stringify({ flags: next, position: current }))
  }

  const leaveTo = React.useCallback(
    (href: string) => {
      leavingRef.current = true
      // The course layout is kept while the student moves between its pages, and it is what says "Mock exam in progress":
      // it is read again with the move, so a submitted exam does not still show as open on its own results.
      React.startTransition(() => {
        router.push(href)
        router.refresh()
      })
    },
    [router]
  )

  // The clock: the server says how long is left; the browser counts down and checks again now and then.
  const [endsAt, setEndsAt] = React.useState(() => clientNow() + attempt.remainingSeconds * 1000)
  const second = React.useSyncExternalStore(
    subscribeToClock,
    () => Math.floor(Date.now() / 1000),
    () => null
  )
  const secondsLeft = second === null ? attempt.remainingSeconds : Math.max(0, Math.ceil(endsAt / 1000) - second)

  const resync = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ attempt: AttemptView | null; submitted?: { submissionId: string } }>(
        `/api/exams/${examId}/attempt`
      )
      if (data.attempt) setEndsAt(clientNow() + data.attempt.remainingSeconds * 1000)
      else if (data.submitted) leaveTo(`${base}/results/${data.submitted.submissionId}`)
      else if (!submittingRef.current) leaveTo(base)
    } catch {
      // Offline: keep counting from the last figure.
    }
  }, [examId, base, leaveTo])

  React.useEffect(() => {
    // Once straight away (the page may have waited for this code to load), then every so often.
    const first = setTimeout(() => void resync(), 0)
    const timer = setInterval(() => void resync(), RESYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void resync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [resync])

  const autosave = useExamAutosave({
    examId,
    answers: stored,
    savedAnswers,
    enabled: !submitting,
    onEnded: (submissionId) => {
      toast(submissionId ? 'Time is up. Your saved answers were submitted.' : 'This exam is no longer in progress.')
      leaveTo(submissionId ? `${base}/results/${submissionId}` : base)
    },
  })

  const submit = React.useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await apiFetch<{ submissionId: string }>(`/api/exams/${examId}/submit`, {
        method: 'POST',
        json: { answers: storedRef.current },
      })
      leaveTo(`${base}/results/${result.submissionId}`)
      return
    } catch (error) {
      if (isApiError(error)) {
        const submissionId = (error.body as { submissionId?: unknown } | undefined)?.submissionId
        if (error.status === 502 && typeof submissionId === 'string') {
          // Submitted, but grading did not start: the results page offers "Grade again".
          toast(error.message)
          leaveTo(`${base}/results/${submissionId}`)
          return
        }
        if (error.status === 409) {
          toast('This exam was already submitted.')
          leaveTo(base)
          return
        }
        setSubmitError(error.message)
      } else {
        setSubmitError('Could not submit your exam. Try again.')
      }
    }
    submittingRef.current = false
    setSubmitting(false)
  }, [examId, base, leaveTo])

  // At zero the exam submits itself, once.
  const autoSubmitted = React.useRef(false)
  React.useEffect(() => {
    if (secondsLeft === 0 && !autoSubmitted.current) {
      autoSubmitted.current = true
      void submit()
    }
  }, [secondsLeft, submit])

  // Submitting always asks first: it is final, and the prompt says what is left blank or flagged.
  const requestSubmit = () => setConfirmSubmit(true)

  useFocusExitGuard(
    React.useCallback(() => {
      if (leavingRef.current || submittingRef.current) return true
      setConfirmExit(true)
      return false
    }, [])
  )

  // Arrow keys and Enter move between questions, unless the student is typing or a dialog is open.
  const dialogOpen = confirmSubmit || confirmExit || navOpen
  React.useEffect(() => {
    if (submitting || dialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      // Arrow keys move between the confidence levels when one is focused.
      if ((event.target as HTMLElement | null)?.closest('[data-confidence-row]')) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        goTo(current + 1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        event.stopPropagation()
        goTo(current - 1)
      } else if (event.key === 'Enter') {
        const tag = (event.target as HTMLElement | null)?.tagName
        if (tag === 'BUTTON' || tag === 'A') return
        event.preventDefault()
        goTo(current + 1)
      }
    }
    // Capture phase, so the arrow keys move between questions even with an option focused.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [current, goTo, submitting, dialogOpen])

  const notice = timeNotice(secondsLeft)
  const isLast = current === total - 1
  const saveText = SAVE_TEXT[autosave.status]

  return (
    <>
      <FocusHeader
        title={title}
        status={
          <>
            <SaveState status={autosave.status} text={saveText} onRetry={() => void autosave.saveNow()} />
            <Timer secondsLeft={secondsLeft} />
          </>
        }
        actions={
          <Button variant="primary" size="sm" loading={submitting} onClick={requestSubmit}>
            Submit
          </Button>
        }
      />

      <div className="mx-auto grid w-full max-w-[1040px] gap-12 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,1fr)_232px] lg:py-10">
        <div className="mx-auto w-full min-w-0 max-w-[720px]">
          {notice ? (
            <InlineAlert className="mb-5" tone={notice.tone}>
              {notice.text}
            </InlineAlert>
          ) : null}
          {submitError ? (
            <InlineAlert
              className="mb-5"
              tone="danger"
              action={
                <Button size="sm" variant="secondary" onClick={() => void submit()}>
                  Try again
                </Button>
              }
            >
              {submitError}
            </InlineAlert>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <h1 className="tabular text-small font-medium text-fg-2">
              Question {current + 1} of {total}
            </h1>
            <Button variant="secondary" size="sm" icon={<SquaresFour />} className="lg:hidden" onClick={() => setNavOpen(true)}>
              Questions
            </Button>
          </div>
          <Progress aria-label="Questions answered" className="mt-3" value={total ? (answeredSet.size / total) * 100 : 0} />

          <div key={current} data-question="" className={cn('mt-8', motion)}>
            <QuestionRenderer
              question={question}
              value={answers[String(current)]}
              onChange={(value) => setAnswers((prev) => ({ ...prev, [String(current)]: value }))}
              disabled={submitting}
              shortcuts={!dialogOpen}
            />
            <ConfidenceRow
              value={confidence[String(current)]}
              level={levels[String(current)]}
              optionCount={optionCountOf(question)}
              onChange={(level, value) => {
                setConfidence((prev) => ({ ...prev, [String(current)]: value }))
                setLevels((prev) => ({ ...prev, [String(current)]: level }))
              }}
            />
          </div>

          <div className="mt-10 flex items-center gap-2">
            <Button variant="secondary" icon={<ArrowLeft />} disabled={current === 0} onClick={() => goTo(current - 1)}>
              Previous
            </Button>
            <Button
              variant="ghost"
              icon={<Flag weight={flagged.has(current) ? 'fill' : 'regular'} className={flagged.has(current) ? 'text-warning' : undefined} />}
              aria-pressed={flagged.has(current)}
              onClick={toggleFlag}
            >
              {flagged.has(current) ? 'Flagged' : 'Flag'}
            </Button>
            <span className="flex-1" />
            {isLast ? (
              <Button variant="primary" loading={submitting} onClick={requestSubmit}>
                Submit exam
              </Button>
            ) : (
              <Button variant="primary" onClick={() => goTo(current + 1)}>
                <span className="inline-flex items-center gap-1.5">
                  Next
                  <ArrowRight className="size-4" aria-hidden="true" />
                </span>
              </Button>
            )}
          </div>
        </div>

        <aside aria-label="Question navigator" className="hidden lg:block">
          <div className="sticky top-[88px]">
            <h2 className="mb-3 text-small font-medium text-fg">Questions</h2>
            <QuestionNavigator total={total} current={current} answered={answeredSet} flagged={flagged} onSelect={goTo} />
          </div>
        </aside>
      </div>

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent className="lg:hidden">
          <SheetHeader>
            <SheetTitle>Questions</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto p-5">
            <QuestionNavigator
              total={total}
              current={current}
              answered={answeredSet}
              flagged={flagged}
              onSelect={(index) => {
                goTo(index)
                setNavOpen(false)
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Submit your exam?"
        description={submitSummary({ total, unanswered, flagged: flagged.size })}
        confirmLabel="Submit exam"
        cancelLabel="Keep working"
        onConfirm={() => submit()}
      />
      <ConfirmDialog
        open={confirmExit}
        onOpenChange={setConfirmExit}
        title="Leave the exam?"
        description="The timer keeps running and your answers are saved."
        confirmLabel="Leave exam"
        cancelLabel="Stay"
        onConfirm={() => leaveTo(base)}
      />
    </>
  )
}
