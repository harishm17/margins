'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, ArrowsClockwise, BookOpen, CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import { Spinner } from '@/components/ui/spinner'
import { ConfidenceRow, optionCountOf, ThinkingBox } from '@/features/topic/quiz-confidence'
import { ReviewList as ResultList, type ReviewEntry } from '@/features/topic/quiz-review-list'
import { useAiStatus } from '@/features/ai/ai-status'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'
import { apiFetch, isApiError } from '@/lib/api/client'
import { normalizeAnswers, type QuizAnswer } from '@/lib/learning/quiz-answers'
import { reviewSessionHref } from '@/lib/learning/review-links'
import type { PublicSessionItem, SessionSummary, SessionView } from '@/lib/learning/review-session-types'
import { useQuestionMotion } from '@/lib/question-motion'
import { cn } from '@/lib/utils'

type Props = {
  courseId: string
  /** A review filtered to this topic. */
  topicId?: string
  /** A drill on this concept. */
  conceptId?: string
  /** A session already started (the address holds it, so a reload goes on where the student was). */
  sessionId?: string
}

const POLL_MS = 2000

const PHASE_LABEL: Partial<Record<PublicSessionItem['phase'], string>> = {
  opening: 'Warm-up',
  retest: 'Fresh retest',
  prerequisite: 'Before this',
}

type Loading = { state: 'starting' } | { state: 'empty'; legacyReview: boolean } | { state: 'error'; message: string; /** The session in the address is gone or is not theirs: trying again cannot help. */ gone: boolean } | { state: 'ready'; view: SessionView }

/**
 * A review session or concept drill, one question at a time. The student answers, optionally says how
 * sure they are, and checks; the feedback stays until they press Next. Nothing moves on by itself, so the
 * pause after a miss is theirs to think in (spec §7.4). When every question is answered a review serves a
 * fresh question for each miss before the summary.
 */
export function ReviewSession({ courseId, topicId, conceptId, sessionId }: Props) {
  const [loading, setLoading] = React.useState<Loading>({ state: 'starting' })
  const [cursor, setCursor] = React.useState<number | null>(null)
  // A right answer goes straight on to the next question (one tap, not two); the note says it was right and keeps the feedback a tap away.
  const [rightNote, setRightNote] = React.useState<number | null>(null)
  const startedRef = React.useRef(false)
  // The session this page made (or was given). Trying again after a failed read goes on with it: starting once more would make a second one.
  const sessionIdRef = React.useRef<string | undefined>(sessionId)
  const motion = useQuestionMotion(cursor ?? 0)

  const adopt = React.useCallback((view: SessionView) => {
    setLoading({ state: 'ready', view })
    setCursor((current) => current ?? view.next ?? view.items.length)
  }, [])

  const start = React.useCallback(async () => {
    setLoading({ state: 'starting' })
    setCursor(null)
    try {
      let id = sessionIdRef.current
      if (!id && !conceptId) {
        // Today's review in progress is gone on with, not started again (spec 18.7): the same kind of session (the same topic filter).
        const found = await apiFetch<{ session: { sessionId: string; short: boolean; topicId: string | null } | null }>(`/api/projects/${courseId}/review-sessions?active=1`).catch(() => null)
        if (found?.session && !found.session.short && found.session.topicId === (topicId ?? null)) {
          id = found.session.sessionId
          sessionIdRef.current = id
          const url = new URL(window.location.href)
          url.searchParams.set('session', id)
          window.history.replaceState(null, '', url)
        }
      }
      if (!id) {
        const created = await apiFetch<{ status: 'created' | 'empty'; sessionId?: string; legacyReview?: boolean }>(`/api/projects/${courseId}/review-sessions`, {
          method: 'POST',
          body: JSON.stringify(conceptId ? { conceptId } : topicId ? { topicId } : {}),
        })
        if (created.status === 'empty' || !created.sessionId) return setLoading({ state: 'empty', legacyReview: created.legacyReview === true })
        id = created.sessionId
        sessionIdRef.current = id
        // The address holds the session, so a reload finds it again instead of starting another.
        const url = new URL(window.location.href)
        url.searchParams.set('session', id)
        window.history.replaceState(null, '', url)
      }
      adopt(await apiFetch<SessionView>(`/api/review-sessions/${id}`))
    } catch (error) {
      const gone = isApiError(error) && !!sessionId && (error.status === 404 || error.status === 403)
      setLoading({ state: 'error', gone, message: isApiError(error) ? error.message : 'Could not start the review. Try again.' })
    }
  }, [adopt, conceptId, courseId, sessionId, topicId])

  React.useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void start()
  }, [start])

  // While questions are being written, ask again every couple of seconds (the server picks up the finished
  // job on each read). A failed read leaves the view as it was, so the next ask is scheduled by a tick that
  // always moves, not by the view; and a hidden tab waits until it is visible again.
  const view = loading.state === 'ready' ? loading.view : null
  const viewId = view?.id
  const preparing = view?.status === 'preparing'
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!viewId || !preparing) return
    const onVisible = () => {
      if (!document.hidden) setTick((t) => t + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    let timer: number | undefined
    if (!document.hidden) {
      timer = window.setTimeout(async () => {
        try {
          adopt(await apiFetch<SessionView>(`/api/review-sessions/${viewId}`))
        } catch {
          // Try again on the next tick.
        } finally {
          setTick((t) => t + 1)
        }
      }, POLL_MS)
    }
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [adopt, preparing, viewId, tick])

  if (loading.state === 'starting') return <Status title="Getting your questions ready" busy />
  if (loading.state === 'empty') {
    // A topic with no concepts is reviewed with its quiz questions: say so rather than "nothing is due".
    if (loading.legacyReview && topicId) {
      return (
        <EmptyState
          icon={<ArrowsClockwise />}
          title="This topic is reviewed with its quiz"
          action={
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/review#review-${topicId}`}>Review with quiz questions</Link>
            </Button>
          }
          secondary={<Link href={`/courses/${courseId}/review`}>Back to Review</Link>}
        >
          Its review is due, but this topic has no idea questions yet, so it is reviewed with the questions from its quizzes.
        </EmptyState>
      )
    }
    return (
      <EmptyState
        icon={<CheckCircle />}
        title={conceptId ? 'Nothing to drill on this yet' : 'Nothing is due'}
        action={
          <Button asChild variant="primary">
            <Link href={`/courses/${courseId}/review`}>Back to Review</Link>
          </Button>
        }
      >
        {conceptId
          ? 'This idea has no questions to practice with yet. Open its topic and take a quiz first.'
          : 'No idea needs another look today. Your next reviews appear on the Review page as they come due.'}
      </EmptyState>
    )
  }
  if (loading.state === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <InlineAlert tone="danger">{loading.message}</InlineAlert>
        <div className="flex gap-2">
          {loading.gone ? null : (
            <Button variant="primary" icon={<ArrowsClockwise />} onClick={() => void start()}>
              Try again
            </Button>
          )}
          <Button asChild variant={loading.gone ? 'primary' : 'secondary'}>
            <Link href={`/courses/${courseId}/review`}>Back to Review</Link>
          </Button>
        </div>
      </div>
    )
  }

  const session = loading.view
  if (session.status === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <InlineAlert tone="danger">{session.message ?? 'We could not prepare this review.'}</InlineAlert>
        <Button asChild variant="secondary" className="self-start">
          <Link href={`/courses/${courseId}/review`}>Back to Review</Link>
        </Button>
      </div>
    )
  }

  const position = cursor ?? session.items.length
  const item = session.items[position]
  if (!item) {
    if (session.status === 'complete' && session.summary) return <Summary courseId={courseId} session={session} summary={session.summary} conceptId={conceptId} />
    return (
      <Status
        title={session.items.some((_i, index) => session.answered[String(index)]) ? 'Writing a fresh question on what you missed' : 'Writing your questions'}
        detail="This takes a moment. The next question appears here as soon as it is ready."
        busy
      />
    )
  }

  const answered = session.answered[String(position)]
  const total = session.items.length
  const answeredCount = Object.keys(session.answered).length
  const isLast = position === total - 1
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="tabular text-body-strong text-fg">
          Question {position + 1} of {total}
          {session.retestsToCome > 0 ? <span className="font-normal text-fg-2"> (+{session.retestsToCome} to retest)</span> : null}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-2">
          {PHASE_LABEL[item.phase] ? (
            <span className="whitespace-nowrap rounded-chip bg-surface-3 px-2 py-0.5 text-caption text-fg">{PHASE_LABEL[item.phase]}</span>
          ) : null}
          <span data-session-context="">{[item.topicName, ...item.conceptNames].filter(Boolean).join(' · ')}</span>
        </p>
      </div>
      <Progress aria-label="Questions answered" className="mt-4" value={(answeredCount / total) * 100} />
      <RightNote courseId={courseId} session={session} position={rightNote} />
      <Step
        key={`${position}:${item.question.question_text}`}
        courseId={courseId}
        sessionId={session.id}
        position={position}
        motion={motion}
        item={item}
        result={answered}
        isLast={isLast}
        canSkip={!isLast}
        complete={session.status === 'complete'}
        firstMiss={Object.values(session.answered).filter((entry) => !entry.correct).length === 1}
        closingRetests={session.closingRetests}
        onGraded={(view) => {
          // A new result replaces the note about the last right answer.
          setRightNote(null)
          adopt(view)
        }}
        onNext={() => {
          setRightNote(null)
          setCursor(position + 1)
        }}
        onRight={() => {
          setRightNote(position)
          setCursor(position + 1)
        }}
      />
    </div>
  )
}

/** What is being written on one question: the draft payload of the review surface (spec 18.7). */
type ReviewDraft = { answer: string; thinking?: string; confidence?: number; confidenceLevel?: string }

function parseDraft(raw: unknown): ReviewDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.answer !== 'string') return null
  const answer = normalizeAnswers({ '0': value })['0']
  return {
    answer: value.answer,
    ...(answer?.thinking ? { thinking: answer.thinking } : {}),
    ...(answer?.confidence !== undefined ? { confidence: answer.confidence } : {}),
    ...(answer?.confidenceLevel ? { confidenceLevel: answer.confidenceLevel } : {}),
  }
}

function Status({ title, detail, busy }: { title: string; detail?: string; busy?: boolean }) {
  return (
    <div role="status" className="flex flex-col items-center px-4 py-16 text-center">
      {busy ? <Spinner className="size-5 text-fg-2" /> : null}
      <p className="mt-4 text-subheading text-fg">{title}</p>
      {detail ? <p className="mt-1.5 max-w-[52ch] text-small text-fg-2">{detail}</p> : null}
    </div>
  )
}

/** "Where to look" for a missed item: the first claim of each concept it tests, as links that open the reader there. */
function Pointers({ pointers }: { pointers: NonNullable<SessionView['answered'][string]['pointers']> }) {
  if (pointers.length === 0) return null
  return (
    <p className="mt-3 text-small text-fg-2" data-testid="where-to-look">
      Where to look:{' '}
      {pointers.map((pointer, position) => (
        <React.Fragment key={pointer.conceptId}>
          {position > 0 ? ', ' : null}
          <Link href={pointer.href} className="text-fg underline underline-offset-2">
            {pointer.page ? (pointers.length > 1 ? `p. ${pointer.page} (${pointer.conceptName})` : `p. ${pointer.page}`) : pointer.conceptName}
          </Link>
        </React.Fragment>
      ))}
    </p>
  )
}

/**
 * After a right answer the session goes straight on (spec 7.4, A9). This says so, in a live region that stays on the page so the
 * words are read out, and keeps the feedback of that answer one tap away.
 */
function RightNote({ courseId, session, position }: { courseId: string; session: SessionView; position: number | null }) {
  const [open, setOpen] = React.useState<number | null>(null)
  const shown = position !== null && session.answered[String(position)]?.correct ? position : null
  const item = shown === null ? null : session.items[shown]
  const result = shown === null ? undefined : session.answered[String(shown)]
  const entries: ReviewEntry[] =
    item && result && shown !== null ? [{ index: shown, question: item.question, review: { ...result.review, questionIndex: shown }, answer: result.answer }] : []
  return (
    <div role="status" aria-live="polite" className="mt-4 empty:hidden">
      {shown !== null ? (
        <div className="rounded-control bg-accent-soft px-3.5 py-2.5 text-small text-accent-soft-fg" data-testid="right-note">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CheckCircle aria-hidden="true" weight="fill" className="size-4" />
              Correct.
            </span>
            <button type="button" aria-expanded={open === shown} onClick={() => setOpen(open === shown ? null : shown)} className="min-h-6 rounded-chip underline underline-offset-2 max-sm:min-h-11">
              {open === shown ? 'Hide the feedback' : 'See the feedback'}
            </button>
          </p>
          {open === shown && item ? (
            <div className="mt-2 rounded-card border border-border bg-surface px-4 text-fg">
              <ResultList entries={entries} courseId={courseId} topicId={item.topicId} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type StepProps = {
  courseId: string
  sessionId: string
  position: number
  motion: string
  item: PublicSessionItem
  result: SessionView['answered'][string] | undefined
  isLast: boolean
  /** Another question is left after this one, so it can be skipped for now. */
  canSkip: boolean
  complete: boolean
  /** This is the first miss of the session: say that misses come back (when the session retests them). */
  firstMiss: boolean
  closingRetests: boolean
  onGraded: (view: SessionView) => void
  onNext: () => void
  /** The answer was right: go straight on to the next question. */
  onRight: () => void
}

/** One question: the answer form, then (after a miss) the feedback with Next. A right answer goes straight on. Remounts for each question. */
function Step({ courseId, sessionId, position, motion, item, result, isLast, canSkip, complete, firstMiss, closingRetests, onGraded, onNext, onRight }: StepProps) {
  const draftHook = useServerDraft<ReviewDraft>('review', `${sessionId}:${position}`, { projectId: courseId, parse: parseDraft })
  // The text is kept here as it is typed; the draft hook saves it (a closed tab, a reload or another device loses nothing).
  const [typed, setTyped] = React.useState<ReviewDraft | null>(null)
  const draft: ReviewDraft = typed ?? draftHook.value ?? { answer: '' }
  const setDraft = (update: (current: ReviewDraft) => ReviewDraft) => {
    const next = update(draft)
    setTyped(next)
    if (next.answer || next.thinking || next.confidence !== undefined) draftHook.set(next)
    else void draftHook.clear()
  }
  const [gradingDown, setGradingDown] = React.useState(false)
  const { report } = useAiStatus()
  const [submitting, setSubmitting] = React.useState<'check' | 'idk' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  // Focus lands on the feedback when it arrives, and on the question when a new one opens.
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [result])

  async function send(kind: 'check' | 'idk') {
    if (submitting) return
    if (kind === 'check' && !draft.answer.trim()) return
    setSubmitting(kind)
    setError(null)
    try {
      const answer =
        kind === 'idk'
          ? { answer: '', idk: true }
          : {
              answer: draft.answer,
              ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
              ...(draft.confidence !== undefined && draft.confidenceLevel ? { confidenceLevel: draft.confidenceLevel } : {}),
              ...(draft.thinking ? { thinking: draft.thinking } : {}),
            }
      const view = await apiFetch<SessionView>(`/api/review-sessions/${sessionId}/answer`, { method: 'POST', body: JSON.stringify({ index: position, answer }) })
      await draftHook.clear()
      onGraded(view)
      // Right answers go straight on; a miss waits for the student (the pause after a miss is theirs).
      if (view.answered[String(position)]?.correct) onRight()
    } catch (caught) {
      // The shared AI status learns of it too, so the banner and every other AI action agree.
      if (isApiError(caught)) report(caught.code)
      setGradingDown(isApiError(caught) && caught.status === 503)
      setError(isApiError(caught) ? caught.message : 'Could not check that answer. Try again.')
    } finally {
      setSubmitting(null)
    }
  }

  async function skip() {
    setSubmitting('check')
    setError(null)
    try {
      const view = await apiFetch<SessionView>(`/api/review-sessions/${sessionId}/skip`, { method: 'POST', body: JSON.stringify({ index: position }) })
      await draftHook.clear()
      onGraded(view)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not skip that question. Try again.')
    } finally {
      setSubmitting(null)
    }
  }

  if (result) {
    const resultEntries: ReviewEntry[] = [{ index: position, question: item.question, review: { ...result.review, questionIndex: position }, answer: result.answer }]
    return (
      <div className={cn('mt-8', motion)} data-question="">
        <h2 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
          {result.correct ? 'Correct' : result.idk ? "You said you don't know" : 'Not quite'}. Feedback for question {position + 1}.
        </h2>
        <ResultList entries={resultEntries} courseId={courseId} topicId={item.topicId} />
        {!result.correct ? <Pointers pointers={result.pointers ?? []} /> : null}
        {!result.correct && firstMiss && closingRetests ? (
          <p className="mt-3 text-small text-fg-2" data-testid="length-notice">
            Misses come back once at the end in a new form.
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-5">
          <Button variant="primary" onClick={onNext}>
            <span className="inline-flex items-center gap-1.5">
              {isLast && !complete ? 'Continue' : isLast ? 'See summary' : 'Next'}
              <ArrowRight className="size-4" />
            </span>
          </Button>
        </div>
      </div>
    )
  }

  const saved = statusLabel(draftHook.status)
  return (
    <div className={cn('mt-8', motion)} data-question="">
      <h2 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        Question {position + 1}
      </h2>
      <QuestionRenderer question={item.question} value={draft.answer} onChange={(answer) => setDraft((d) => ({ ...d, answer }))} showPoints={false} shortcuts />
      <ConfidenceRow
        value={draft.confidence}
        level={draft.confidenceLevel as QuizAnswer['confidenceLevel']}
        optionCount={optionCountOf(item.question)}
        onChange={(confidenceLevel, confidence) => setDraft((d) => ({ ...d, confidence, confidenceLevel }))}
      />
      <ThinkingBox value={draft.thinking ?? ''} onChange={(thinking) => setDraft((d) => ({ ...d, thinking }))} />
      {error ? (
        <InlineAlert className="mt-6" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
      <div className="mt-10 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
        {saved && draft.answer ? <p className="mr-auto text-caption text-fg-3">{saved}</p> : null}
        {gradingDown && canSkip ? (
          <Button variant="secondary" onClick={() => void skip()} disabled={!!submitting}>
            Skip for now
          </Button>
        ) : null}
        <Button variant="ghost" className="text-fg-2" onClick={() => void send('idk')} loading={submitting === 'idk'} disabled={!!submitting}>
          I don&apos;t know
        </Button>
        <Button variant="primary" onClick={() => void send('check')} loading={submitting === 'check'} disabled={!draft.answer.trim() || !!submitting}>
          Check answer
        </Button>
      </div>
    </div>
  )
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The topic of the first question that was missed, or null when nothing was missed: where the student goes to look at it again. */
function missedTopic(session: SessionView): { id: string; name: string } | null {
  for (const item of session.items) {
    const answer = session.answered[String(item.index)]
    if (answer && !answer.correct) return { id: item.topicId, name: item.topicName }
  }
  return null
}

/**
 * The end of a review or drill (spec 7.4). Misses are listed with where to read about them, and the main action is the reading,
 * not the same questions again: a drill that went 0 of N shows what to read, never a dead end. Drilling again stays, second.
 */
function Summary({ courseId, session, summary, conceptId }: { courseId: string; session: SessionView; summary: SessionSummary; conceptId?: string }) {
  const list = (names: string[]) => names.join(', ')
  const help = summary.helpAfterMiss
  const missed = summary.total - summary.correct
  // Where to go with a miss: read about it first. Without a pointer (a concept with no claim) the topic it came from.
  const trouble = missed > 0
  const topic = trouble ? missedTopic(session) : null
  const lead = help?.pointers[0] ?? null
  return (
    <section aria-labelledby="summary-heading">
      <h1 id="summary-heading" className="text-title text-fg">
        {session.kind === 'drill' ? 'Drill done' : 'Review done'}
      </h1>
      <p className="mt-2 text-body text-fg-2">
        You got {summary.correct} of {plural(summary.total, 'question')} right
        {summary.retests.total > 0
          ? `, then ${summary.retests.correct} of ${plural(summary.retests.total, 'fresh retest')} right.`
          : '.'}
      </p>
      <div aria-live="polite" className="mt-2">
        <ExpectedMiss surface="review_summary" summaryMissedShare={summary.total > 0 ? missed / summary.total : 0} />
      </div>
      <dl className="mt-6 flex flex-col gap-4">
        {summary.recovered.length > 0 ? (
          <div>
            <dt className="text-body-strong text-fg">Back on track</dt>
            <dd className="mt-0.5 text-small text-fg-2">{list(summary.recovered)}</dd>
          </div>
        ) : null}
        {summary.stillShaky.length > 0 ? (
          <div>
            <dt className="text-body-strong text-fg">Still shaky</dt>
            <dd className="mt-0.5 text-small text-fg-2">{list(summary.stillShaky)}. It comes back in your next review.</dd>
          </div>
        ) : null}
        {summary.notRetested.length > 0 ? (
          <div>
            <dt className="text-body-strong text-fg">Not retested</dt>
            <dd className="mt-0.5 text-small text-fg-2">
              {list(summary.notRetested)}. No new question could be written just now, so it comes back in your next review.
            </dd>
          </div>
        ) : null}
        {summary.recovered.length === 0 && summary.stillShaky.length === 0 && summary.notRetested.length === 0 && !trouble ? (
          <div>
            <dt className="text-body-strong text-fg">Nothing missed</dt>
            <dd className="mt-0.5 text-small text-fg-2">Every question was right, so nothing needed a retest.</dd>
          </div>
        ) : null}
      </dl>
      {help && help.pointers.length > 0 ? (
        <section aria-labelledby="read-heading" className="mt-6" data-testid="what-to-read">
          <h2 id="read-heading" className="text-body-strong text-fg">
            What to look at
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {help.pointers.map((pointer) => (
              <li key={pointer.conceptId} className="text-small text-fg-2">
                <Link href={pointer.href} className="text-fg underline underline-offset-2">
                  {pointer.conceptName}
                </Link>
                {pointer.page ? <span className="tabular">, p. {pointer.page}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border pt-5">
        {lead ? (
          <Button asChild variant="primary" icon={<BookOpen />}>
            <Link href={lead.href}>Read about {lead.conceptName}</Link>
          </Button>
        ) : topic ? (
          <Button asChild variant="primary">
            <Link href={`/courses/${courseId}/topics/${topic.id}`}>
              <span className="inline-flex items-center gap-1.5">
                Go to {topic.name}
                <ArrowRight aria-hidden="true" className="size-4" />
              </span>
            </Link>
          </Button>
        ) : null}
        {help?.explainer ? (
          <Button asChild variant="secondary">
            <Link href={help.explainer.href}>Read the explanation</Link>
          </Button>
        ) : null}
        {help?.easierStep ? (
          <Button asChild variant="secondary">
            <Link href={help.easierStep.href}>{help.easierStep.label}</Link>
          </Button>
        ) : null}
        {trouble && session.kind === 'drill' && conceptId ? (
          <Button asChild variant="secondary">
            {/* A full page load: the session in the address is this one, and a client move to the same page would keep it. */}
            <a href={reviewSessionHref(courseId, { conceptId })}>Drill this again</a>
          </Button>
        ) : null}
        <Button asChild variant={trouble ? 'ghost' : 'primary'}>
          <Link href={`/courses/${courseId}/review`}>Back to Review</Link>
        </Button>
      </div>
    </section>
  )
}
