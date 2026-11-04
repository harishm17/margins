'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, CaretDown, CheckCircle, Lightning, MinusCircle } from '@phosphor-icons/react/dist/ssr'
import { outcomeLabel } from '@/lib/learning/outcome-words'
import { SourceLink } from '@/components/learning/source-link'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Progress } from '@/components/ui/progress'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import { QuestionText } from '@/components/ui/question-text'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { apiFetch, isApiError } from '@/lib/api/client'
import { CONFIDENCE_LEVELS, CONFIDENCE_WORDS, type ConfidenceId } from '@/lib/learning/calibration'
import type { QuizAnswer } from '@/lib/learning/quiz-answers'
import { WARMUP_IDK_ANSWER } from '@/lib/learning/warmup-idk'
import type { WarmupDoneItem, WarmupState } from '@/lib/learning/warmup-session'
import { useQuestionMotion } from '@/lib/question-motion'
import { cn } from '@/lib/utils'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'
import { parseReviewDraft, type ReviewDraft } from '@/lib/drafts/review-draft'
import { ConfidenceRow, optionCountOf } from './quiz-confidence'
import { formatAnswer, formatKey } from './quiz-format'
import { useActivityInProgress, useAttemptFocus } from './topic-provider'
import { useFocusWhen } from '@/lib/hooks/use-focus'

/** A finished warm-up also says how many passages the reader marks Focus here. */
export type WarmupDisplay = WarmupState | (Extract<WarmupState, { status: 'done' }> & { focusCount: number })

type Props = {
  topicId: string
  /** The course, which the unsent answer is kept under. */
  courseId: string
  /** Where "Start reading" goes. */
  readHref: string
  /** Where the test-out offer goes. */
  quizHref: string
  initial: WarmupDisplay
}

const LEVEL_WORDS = CONFIDENCE_WORDS

/**
 * The warm-up before reading (spec §5.1): a few questions, one at a time, each with an optional one-tap confidence and
 * nothing to look up. Nothing is marked while the student is answering; the answers, and where in their files to find each,
 * come at the end. Skipping ("Start reading") sets nothing.
 */
export function WarmupView({ topicId, courseId, readHref, quizHref, initial }: Props) {
  const router = useRouter()
  const [state, setState] = React.useState<WarmupDisplay>(initial)
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Focus moves to the question only once the student has acted: a page that opens on it keeps the focus where it was.
  const [moved, setMoved] = React.useState(false)
  // Questions on screen: the next-activity card waits. The results end in their own way on (Start reading, below),
  // so the card does not repeat it above them, on a first paint, a reload or a return.
  useActivityInProgress(state.status === 'asking' || state.status === 'done')

  async function start() {
    setStarting(true)
    setError(null)
    try {
      setState(await apiFetch<WarmupDisplay>(`/api/topics/${topicId}/item-sessions`, { method: 'POST', json: { kind: 'warmup' } }))
      setMoved(true)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not start the warm-up. Try again.')
    } finally {
      setStarting(false)
    }
  }

  const advance = (next: WarmupDisplay) => {
    setMoved(true)
    setState(next)
  }

  const finished = React.useCallback(() => {
    // The path ticks the warm-up and the next card moves on.
    React.startTransition(() => router.refresh())
  }, [router])

  if (state.status === 'asking') {
    return <Question key={`${state.sessionId}:${state.index}`} topicId={topicId} courseId={courseId} state={state} moved={moved} onState={advance} onFinished={finished} />
  }
  if (state.status === 'done') return <Results state={state} readHref={readHref} quizHref={quizHref} focusHeading={moved} />

  return (
    <section aria-labelledby="warmup-heading" className="max-w-[640px]">
      <h2 id="warmup-heading" className="text-title text-fg">
        Try a few questions first
      </h2>
      <p className="mt-3 text-body text-fg-2">
        {state.status === 'ready' ? `${state.total} questions, one at a time. ` : ''}
        Try what you know; answers and page pointers come at the end. This won&apos;t affect your quiz score.
      </p>
      <p className="mt-2 text-body text-fg-2">Missing some is fine: it shows what to focus on when you read, and what you read afterwards sticks better.</p>
      {error ? (
        <InlineAlert className="mt-5" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<Lightning />} loading={starting} onClick={() => void start()} disabled={state.status !== 'ready'}>
          Start warm-up
        </Button>
        <Button asChild variant="secondary">
          <Link href={readHref} scroll={false}>
            Start reading
          </Link>
        </Button>
      </div>
    </section>
  )
}

function Question({
  topicId,
  courseId,
  state,
  moved,
  onState,
  onFinished,
}: {
  topicId: string
  courseId: string
  state: Extract<WarmupState, { status: 'asking' }>
  moved: boolean
  onState: (state: WarmupDisplay) => void
  onFinished: () => void
}) {
  // The unsent answer and its confidence live on the server (spec 18.7): a reload, a closed tab or another device keeps them.
  // Warm-up sessions are item sessions like a review's, so they share its draft shape.
  const draftHook = useServerDraft<ReviewDraft>('review', `${state.sessionId}:${state.index}`, { projectId: courseId, parse: parseReviewDraft })
  const [typed, setTyped] = React.useState<QuizAnswer | null>(null)
  const draft: QuizAnswer = typed ?? (draftHook.value as QuizAnswer | null) ?? { answer: '' }
  const setDraft = (update: (current: QuizAnswer) => QuizAnswer) => {
    const next = update(draft)
    setTyped(next)
    if (next.answer || next.confidence !== undefined) draftHook.set(next as ReviewDraft)
    else void draftHook.clear()
  }
  const saved = draft.answer || draft.confidence !== undefined ? statusLabel(draftHook.status) : null
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const motion = useQuestionMotion(state.position)
  const last = state.position === state.total
  // A question being answered is an attempt: on a phone the topic's header and path give way to a small bar with Exit.
  useAttemptFocus(true)

  React.useEffect(() => {
    if (moved) headingRef.current?.focus({ preventScroll: true })
  }, [moved])

  /** The answer, or "I don't know" (spec 18.3): a miss with no confidence, which the bracket answers by going easier. */
  async function submit(dontKnow = false) {
    if (submitting) return
    if (!dontKnow && !draft.answer.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const next = await apiFetch<WarmupDisplay>(`/api/topics/${topicId}/item-sessions`, {
        method: 'PATCH',
        json: {
          sessionId: state.sessionId,
          index: state.index,
          answer: dontKnow
            ? { answer: WARMUP_IDK_ANSWER }
            : {
                answer: draft.answer,
                ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
                ...(draft.confidence !== undefined && draft.confidenceLevel ? { confidenceLevel: draft.confidenceLevel } : {}),
              },
        },
      })
      // The answer is in: the draft has done its work. Cleared only now, so a failed save keeps what was typed.
      await draftHook.clear()
      onState(next)
      if (next.status === 'done') onFinished()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save that answer. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-label="Warm-up" className="max-w-[640px]">
      <div className="flex items-center justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="tabular text-body-strong text-fg outline-none">
          Warm-up question {state.position} of {state.total}
        </h2>
        <p className="text-small text-fg-2">Answers come at the end</p>
      </div>
      <Progress aria-label="Warm-up questions answered" className="mt-3 sm:mt-4" value={((state.position - 1) / state.total) * 100} />
      <div className={cn('mt-5 sm:mt-8', motion)} data-question="">
        <QuestionRenderer question={state.question} value={draft.answer} onChange={(answer) => setDraft((d) => ({ ...d, answer }))} showPoints={false} shortcuts />
        <ConfidenceRow
          value={draft.confidence}
          level={draft.confidenceLevel}
          optionCount={optionCountOf(state.question)}
          onChange={(confidenceLevel, confidence) => setDraft((d) => ({ ...d, confidence, confidenceLevel }))}
        />
        {error ? (
          <InlineAlert className="mt-6" tone="danger">
            {error}
          </InlineAlert>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4 sm:mt-10 sm:pt-5">
          {saved ? (
            <span role="status" className="mr-auto text-caption text-fg-3" data-testid="warmup-draft-status">
              {saved}
            </span>
          ) : null}
          <Button variant="ghost" onClick={() => void submit(true)} disabled={submitting} data-testid="warmup-idk">
            I don&apos;t know
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={!draft.answer.trim()} disabledReason="Pick an answer first.">
            <span className="inline-flex items-center gap-1.5">
              {last ? 'See answers' : 'Next question'}
              <ArrowRight className="size-4" />
            </span>
          </Button>
        </div>
      </div>
    </section>
  )
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function ResultRow({ item }: { item: WarmupDoneItem }) {
  const given = formatAnswer(item.question, item.answer)
  const key = formatKey(item.question, item.correctAnswer)
  const source = item.sources[0]
  const level = CONFIDENCE_LEVELS.find((l) => l.id === item.confidenceLevel)?.id
  const outcome = { correct: item.correct, idk: item.idk }
  return (
    <li className="py-1 first:pt-0">
      {/* One line per question (its number, how it went, the question), the detail opens from it: the answers are for looking things up. */}
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2.5 py-2.5 [&::-webkit-details-marker]:hidden">
          {item.correct ? (
            <CheckCircle aria-hidden="true" weight="fill" className="mt-0.5 size-5 shrink-0 text-accent" />
          ) : (
            // A pretest miss is expected, and is what the reading is for: a quiet mark, not the red of a failed test.
            <MinusCircle aria-hidden="true" weight="fill" className="mt-0.5 size-5 shrink-0 text-fg-3" />
          )}
          <span className="min-w-0 flex-1">
            <span className={cn('block text-small font-medium', item.correct ? 'text-accent' : 'text-fg-2')}>
              {item.position}. {outcomeLabel(outcome, 'short')}
            </span>
            <span className="mt-0.5 block text-body-strong text-fg">
              <QuestionText compact>{item.question.question_text}</QuestionText>
            </span>
          </span>
          <CaretDown aria-hidden="true" className="mt-1.5 size-4 shrink-0 text-fg-3 transition-transform duration-180 group-open:rotate-180" />
        </summary>
        <div className="pb-4 pl-[30px]">
          <dl className="flex flex-col gap-2">
            <div>
              <dt className="text-caption text-fg-3">Your answer</dt>
              <dd className="mt-0.5 text-small text-fg">
                {item.idk ? "I don't know" : given || 'No answer'}
                {level && !item.idk ? <span className="text-fg-3"> ({LEVEL_WORDS[level]})</span> : null}
              </dd>
            </div>
            {item.correct ? null : (
              <div>
                <dt className="text-caption text-fg-3">Answer</dt>
                <dd className="mt-0.5 text-small text-fg">{key}</dd>
              </div>
            )}
          </dl>
          {source ? (
            <p className="mt-3 text-small text-fg-2">
              You&apos;ll find this {source.pageStart !== null ? 'on ' : 'in '}
              <SourceLink source={source} />
            </p>
          ) : null}
        </div>
      </details>
    </li>
  )
}

function Results({ state, readHref, quizHref, focusHeading }: { state: Extract<WarmupState, { status: 'done' }> & { focusCount?: number }; readHref: string; quizHref: string; focusHeading: boolean }) {
  // The last question is gone: a student who has just finished lands on the results, not on the page.
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  useFocusWhen(focusHeading, headingRef)
  const right = state.items.filter((item) => item.correct).length
  const toFocus = state.items.length - right
  const focus = state.focusCount ?? 0
  // The questions to focus on come first: they are why the reading marks passages Focus. The ones answered right follow.
  const ordered = [...state.items].sort((a, b) => Number(a.correct) - Number(b.correct) || a.position - b.position)
  return (
    <section aria-labelledby="warmup-done-heading" className="max-w-[640px]">
      <h2 ref={headingRef} id="warmup-done-heading" className="text-title text-fg outline-none">
        Ready to read
      </h2>
      <p className="mt-2 text-body text-fg-2">
        {toFocus > 0 ? `${plural(toFocus, 'idea')} to focus on. ` : 'You answered every question right. '}
        You got {right} of {plural(state.items.length, 'question')} right. Open a question below to see its answer and where to find it.
      </p>
      {right < state.items.length ? (
        <div aria-live="polite" className="mt-2">
          <ExpectedMiss surface="warmup_results" />
        </div>
      ) : null}
      {/* The way on is at the top, with what the reading will mark: the answers below are for looking things up, not a page to get through first. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button asChild variant="primary">
          <Link href={readHref} scroll={false}>
            <span className="inline-flex items-center gap-1.5">
              Start reading
              <ArrowRight className="size-4" />
            </span>
          </Link>
        </Button>
        {focus > 0 ? (
          <p className="min-w-0 flex-1 basis-56 text-small text-fg-2">
            {plural(focus, 'passage')} in the reading {focus === 1 ? 'is' : 'are'} marked Focus here, for the ideas you missed or guessed. Everything is still there to read.
          </p>
        ) : null}
      </div>
      <ol className="mt-6 divide-y divide-border border-t border-border pt-3">
        {ordered.map((item) => (
          <ResultRow key={item.position} item={item} />
        ))}
      </ol>
      {state.testOut ? (
        <InlineAlert
          className="mt-4"
          tone="accent"
          title="You may know this already"
          action={
            <Button asChild variant="link" className="text-small font-medium">
              <Link href={quizHref} scroll={false}>
                Take the quiz now
                <ArrowRight className="ml-1 size-3.5" />
              </Link>
            </Button>
          }
        >
          You got every question right and were sure of each one.
        </InlineAlert>
      ) : null}
    </section>
  )
}
