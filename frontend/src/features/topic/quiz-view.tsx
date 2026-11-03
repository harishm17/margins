'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { apiFetch, isApiError } from '@/lib/api/client'
import { track as trackEvent } from '@/lib/analytics/track'
import type { QuizReviewItem } from '@/lib/learning/quiz-review'
import type { QuizAttemptData, QuizSetData, TopicReview } from '@/server/queries/topic'
import { QuizLobby } from './quiz-lobby'
import { freshHardSet } from './quiz-hard'
import type { WaitingQuiz } from '@/lib/learning/quiz-submissions'
import { QuizResults, type QuizResult } from './quiz-results'
import { setBeingTaken, useQuizSession } from './quiz-session'
import { QuizTaking } from './quiz-taking'
import { answersToSend, confidences, plainAnswers } from '@/lib/learning/quiz-answers'
import { statusLabel } from '@/features/learning/use-server-draft'
import { QuizWaiting } from './quiz-waiting'
import type { PartialQuiz } from '@/lib/learning/quiz-partial'
import { useActivityInProgress, useGeneration, useTopic } from './topic-provider'
import { useAiStatus } from '@/features/ai/ai-status'

type SubmitResponse =
  | {
      status: 'graded'
      score: number
      earnedPoints: number
      totalPoints: number
      bestScore: number
      review: QuizReviewItem[]
      /** What the attempt changed: the next review and how mastery moved. */
      outcome?: QuizResult['outcome']
      helpAfterMiss?: QuizResult['helpAfterMiss']
      missedConcepts?: QuizResult['missedConcepts']
    }
  | {
      /** The multiple choice answers were graded at once and the short answers wait (spec 18.9): no overall score. */
      status: 'partial'
      submissionId: string
      jobId: string | null
      started: boolean
      code: string | null
      partial: PartialQuiz
    }
  | {
      /** The short answers could not be graded now: the quiz is stored and graded when the AI is back. */
      status: 'waiting'
      submissionId: string
      jobId: string | null
      started: boolean
      code: string | null
    }

type QuizViewProps = {
  courseId: string
  topicId: string
  sets: QuizSetData[]
  attempts: QuizAttemptData[]
  /** Quizzes stored while the AI could not grade them. */
  waiting: WaitingQuiz[]
  voiceHref: string
  /** Whether a review is due, and how many questions were missed lately. */
  review: TopicReview
  /** The set to show first (?set=), and whether to start it at once (?start=1, from "Retry what you missed"). */
  initialSetId?: string
  autoStart?: boolean
  /** ?difficulty=hard, from the transfer-quiz activity: open a fresh hard set, or offer to write one. */
  harder?: boolean
}

/**
 * The quiz: lobby, taking, grading and results in one view; the URL stays on ?view=quiz.
 * A quiz in progress lives in sessionStorage, so "taking" is simply "a session is stored".
 * Grading and results are in memory: the graded attempt is saved on the server either way.
 */
export function QuizView({ courseId, topicId, sets, attempts, waiting, voiceHref, review, initialSetId, autoStart, harder }: QuizViewProps) {
  const router = useRouter()
  const { setKeysSuspended, generateReview } = useTopic()
  const { running, generate } = useGeneration('quiz')
  // The set asked for (?set=), else the student's own pick, else the newest regular set: a retry set
  // made a moment ago is not the one to open next week. A pick made before another set was asked for is dropped.
  // A quiz this tab is in the middle of stays chosen across a remount (the page remounts this view when a newer set arrives).
  const [pick, setPick] = React.useState<{ id: string; whenAsked: string | undefined } | null>(() => {
    const taken = setBeingTaken(topicId, sets.map((item) => item.id))
    return taken ? { id: taken, whenAsked: initialSetId } : null
  })
  const asked = initialSetId && sets.some((item) => item.id === initialSetId) ? initialSetId : undefined
  const picked = pick && pick.whenAsked === initialSetId && sets.some((item) => item.id === pick.id) ? pick.id : undefined
  const hardSetId = harder ? freshHardSet(sets, attempts) : null
  const setId = picked ?? asked ?? hardSetId ?? (sets.find((item) => item.kind === 'standard') ?? sets[0]).id
  const activeSet = sets.find((item) => item.id === setId) ?? sets[0]
  const quiz = useQuizSession(courseId, topicId, activeSet.id)
  const { session, taking: takingHere, begin, save, pause, discard, finish, refused } = quiz
  // Starting or resuming pins the set: a newer set that arrives mid-quiz (a generation finishing in the
  // background) must not swap the questions under the student. Their pick stays until they choose another.
  function beginOnThisSet(...args: Parameters<typeof begin>) {
    setPick({ id: activeSet.id, whenAsked: initialSetId })
    return begin(...args)
  }
  // After "Save and finish later" the lobby says where the answers are.
  const [savedNote, setSavedNote] = React.useState(false)
  const [grading, setGrading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ setId: string; value: QuizResult } | null>(null)
  // Quizzes stored for the AI, kept here until their results are shown: the server's list drops one the
  // moment it is graded, which can happen before this page has asked for the result.
  const [known, setKnown] = React.useState<Record<string, { item: WaitingQuiz; onServer: boolean }>>(() =>
    Object.fromEntries(waiting.map((item) => [item.submissionId, { item, onServer: true }]))
  )
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [graded, setGraded] = React.useState<string[]>([])
  // When the server's list changes, take in what is new (state adjusted while rendering, not in an effect).
  const [seenList, setSeenList] = React.useState(waiting)
  if (seenList !== waiting) {
    setSeenList(waiting)
    setKnown((current) => {
      const next = { ...current }
      for (const item of waiting) next[item.submissionId] = { item, onServer: true }
      return next
    })
  }
  const waitingItems = React.useMemo(
    () =>
      Object.values(known)
        .filter(({ item }) => !graded.includes(item.submissionId))
        .map(({ item, onServer }) => ({
          item: waiting.find((current) => current.submissionId === item.submissionId) ?? item,
          // It was on the server's list and is not now: it has been graded, so ask for the result.
          gone: onServer && !waiting.some((current) => current.submissionId === item.submissionId),
        })),
    [known, waiting, graded]
  )
  const focused = waitingItems.find(({ item }) => item.submissionId === focusId)?.item ?? null

  const started = React.useRef(false)
  React.useEffect(() => {
    if (!autoStart) {
      started.current = false
      return
    }
    if (started.current) return
    started.current = true
    beginOnThisSet({ answers: {}, index: 0 })
    trackEvent('quiz_started')
    // The address drops ?start=1, so a reload does not start the set again (the set stays chosen).
    router.replace(`/courses/${courseId}/topics/${topicId}?view=quiz${initialSetId ? `&set=${initialSetId}` : ''}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart])

  const taking = !!session && takingHere && !grading && !result
  React.useEffect(() => {
    setKeysSuspended(taking)
    return () => setKeysSuspended(false)
  }, [taking, setKeysSuspended])
  // A quiz being taken or graded: the next-activity card waits until the results are in.
  useActivityInProgress(taking || grading)

  const answers = session?.answers ?? {}
  const { report } = useAiStatus()

  function start(predicted?: number) {
    setError(null)
    setResult(null)
    setSavedNote(false)
    beginOnThisSet({ answers: {}, index: 0, ...(predicted === undefined ? {} : { predicted }) })
    trackEvent('quiz_started')
  }

  /** The lobby's Resume: carry on with the saved answers, from the question they stopped at. */
  function resume() {
    setError(null)
    setResult(null)
    setSavedNote(false)
    beginOnThisSet()
  }

  /** "Harder set": ten new hard questions, the same set the transfer quiz writes. */
  async function harderSet() {
    setError(null)
    setResult(null)
    await generate('regenerate', { question_count: 10, difficulty_level: 'hard' })
  }

  /** "New questions": a fresh set at the topic's band, written by the same path as Fix it now. */
  async function newQuestions() {
    setError(null)
    setResult(null)
    const started = await generateReview()
    if (!started) setError('Could not start a new set. Try again.')
  }

  /** The student dismissed a stored quiz: it is gone from here (the server removed it). */
  function dismissed(item: WaitingQuiz) {
    setGraded((ids) => [...ids, item.submissionId])
    setFocusId(null)
  }

  /** A quiz that waited for the AI has been graded: show its results, whichever set it was. */
  function showGraded(item: WaitingQuiz, value: QuizResult) {
    setGraded((ids) => [...ids, item.submissionId])
    setFocusId(null)
    setPick({ id: item.setId, whenAsked: initialSetId })
    setResult({ setId: item.setId, value })
  }

  async function submit() {
    if (!session) return
    setError(null)
    setGrading(true)
    try {
      const response = await apiFetch<SubmitResponse>(`/api/topics/${topicId}/quiz-attempts`, {
        method: 'POST',
        json: {
          answers: answersToSend(session.answers),
          ...(activeSet.id === 'legacy' ? {} : { quizSetId: activeSet.id }),
        },
      })
      if (response.status === 'waiting' || response.status === 'partial') {
        // Stored whole; graded by itself when the AI is back. The answers no longer live only in this tab.
        if (response.code) report(response.code)
        const item: WaitingQuiz = {
          submissionId: response.submissionId,
          setId: activeSet.id,
          jobId: response.jobId,
          state: response.started ? 'grading' : 'failed',
          errorCode: response.started ? null : 'ENQUEUE_FAILED',
          ...(response.status === 'partial' ? { partial: response.partial } : {}),
        }
        setKnown((current) => ({ ...current, [item.submissionId]: { item, onServer: false } }))
        setFocusId(item.submissionId)
        void finish()
        React.startTransition(() => router.refresh())
        return
      }
      setResult({
        setId: activeSet.id,
        value: {
          score: response.score,
          earnedPoints: response.earnedPoints,
          totalPoints: response.totalPoints,
          bestScore: response.bestScore,
          review: response.review,
          outcome: response.outcome,
          helpAfterMiss: response.helpAfterMiss,
          missedConcepts: response.missedConcepts,
          answers: plainAnswers(session.answers),
          confidence: confidences(session.answers),
          predicted: session.predicted,
        },
      })
      void finish()
      React.startTransition(() => router.refresh())
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      setError(
        isApiError(caught)
          ? caught.message
          : "Couldn't grade the quiz just now. Your answers are still here, so try again."
      )
    } finally {
      setGrading(false)
    }
  }

  if (grading) {
    return (
      <div className="mx-auto flex max-w-[420px] flex-col items-center py-16 text-center" aria-live="polite" aria-busy="true">
        <Spinner className="size-5 text-accent" />
        <h2 className="mt-4 text-heading text-fg">Grading your answers</h2>
        <p className="mt-1.5 text-small text-fg-2">
          This can take up to half a minute when there are short answers.
        </p>
        <Progress aria-label="Grading your answers" indeterminate className="mt-6 max-w-[280px]" />
      </div>
    )
  }

  if (result && result.setId === activeSet.id) {
    return (
      <QuizResults
        courseId={courseId}
        topicId={topicId}
        questions={activeSet.questions}
        result={result.value}
        voiceHref={voiceHref}
        onNewQuestions={() => void newQuestions()}
        onHarderSet={() => void harderSet()}
        onClose={() => setResult(null)}
      />
    )
  }

  if (focused && !session) {
    return (
      <QuizWaiting
        key={`${focused.submissionId}:${focused.jobId}:${focused.state}`}
        courseId={courseId}
        topicId={topicId}
        questions={sets.find((candidate) => candidate.id === focused.setId)?.questions}
        item={focused}
        variant="page"
        gone={waitingItems.find((entry) => entry.item.submissionId === focused.submissionId)?.gone ?? false}
        onGraded={showGraded}
        onDismiss={dismissed}
        onLeave={() => setFocusId(null)}
      />
    )
  }

  if (session && takingHere) {
    return (
      <QuizTaking
        questions={activeSet.questions}
        answers={answers}
        index={session.index}
        error={error}
        onAnswer={(index, value) => {
          // Answering takes back an "I don't know" on the same question.
          const { idk: _idk, ...before } = session.answers[String(index)] ?? { answer: '' }
          save({ ...session, answers: { ...session.answers, [String(index)]: { ...before, answer: value } } })
        }}
        onDontKnow={(index, on) => {
          const { [String(index)]: _gone, ...rest } = session.answers
          save({ ...session, answers: on ? { ...rest, [String(index)]: { answer: '', idk: true } } : rest })
        }}
        onDetail={(index, detail) =>
          save({ ...session, answers: { ...session.answers, [String(index)]: { ...session.answers[String(index)], answer: session.answers[String(index)]?.answer ?? '', ...detail } } })
        }
        onIndex={(index) => save({ ...session, index })}
        onSubmit={submit}
        onSaveAndExit={async () => {
          await pause()
          setSavedNote(true)
        }}
        onDiscard={discard}
        saveStatus={statusLabel(quiz.status)}
      />
    )
  }

  return (
    <>
      {waitingItems.length > 0 ? (
        <div className="mb-6 flex flex-col gap-3">
          {waitingItems.map(({ item, gone }) => (
            <QuizWaiting
              key={`${item.submissionId}:${item.jobId}:${item.state}`}
              topicId={topicId}
              item={item}
              variant="card"
              gone={gone}
              onGraded={showGraded}
              onDismiss={dismissed}
            />
          ))}
        </div>
      ) : null}
      <QuizLobby
        courseId={courseId}
        topicId={topicId}
        review={review}
        sets={sets}
        attempts={attempts}
        setId={activeSet.id}
        onSetChange={(id) => {
          setPick({ id, whenAsked: initialSetId })
          setResult(null)
        }}
        onStart={start}
        resume={session && quiz.answered > 0 ? { answered: quiz.answered } : null}
        onResume={resume}
        refused={!!refused}
        onNewQuestions={() => void newQuestions()}
        savedNote={savedNote}
        generating={!!running && !running.done}
        harder={harder ? { fresh: hardSetId === activeSet.id } : undefined}
      />
    </>
  )
}
