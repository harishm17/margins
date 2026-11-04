'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, CaretDown, Plus } from '@phosphor-icons/react/dist/ssr'
import { SourceLine } from '@/components/learning/source-link'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { MathText } from '@/components/ui/math-text'
import { Progress } from '@/components/ui/progress'
import { pluralize } from '@/lib/format'
import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import { difficultyRank, nextPracticeProblem } from '@/lib/learning/practice-next'
import { cn } from '@/lib/utils'
import { ConceptChip } from './concept-chip'
import { GenerateOptions } from './generation-ui'
import { checkPracticeAnswer } from './practice-check'
import { problemKey } from './practice-keys'
import { usePracticeProgress } from './practice-progress'
import { useActivityInProgress, useAttemptFocus, useOptionalTopic } from './topic-provider'
import type { PracticeContent, PracticeProblem, PracticeStep } from './types'
import { ActiveStep, ProblemSwitcher, StepMarker, TrippedUp } from './practice-step'
import { lastProblemOf, problemDone, stepKeys, stepStatus, type Feedback } from './practice-state'

/**
 * Practice: one problem at a time, worked a step at a time. Answers are checked here in the
 * browser. Solved steps, answers shown and hints used are remembered in the browser and stored on the
 * server (see practice-progress.ts), so they follow the student across devices.
 */
export function PracticeView({ topicId, practice }: { topicId: string; practice: PracticeContent }) {
  const problems = practice.items
  const { progress, rejected, rejections, dismissRejected, recordCheck, markDontKnow, markRevealed, markHinted, setTrippedUp, clear } = usePracticeProgress(topicId)
  const courseId = useOptionalTopic()?.courseId ?? null
  // What to read after a miss, by step (spec 18.3): the closing line of a problem with nothing solved points to it.
  const [helps, setHelps] = React.useState<Record<string, HelpAfterMiss>>({})
  const [picked, setPicked] = React.useState<number | null>(null)
  const [shown, setShown] = React.useState<(Feedback & { rejections: number }) | null>(null)
  // Feedback from before the server refused a save is stale: the progress went back to the server's state.
  const feedback = shown && shown.rejections === rejections ? shown : null
  const setFeedback = (next: Feedback | null) => setShown(next && { ...next, rejections })

  const firstOpenProblem = problems.findIndex((problem, index) => !problemDone(progress, problem, index))
  // Until the student picks one, start where they left off.
  const problemIndex = Math.min(picked ?? Math.max(0, firstOpenProblem), problems.length - 1)
  const problem = problems[problemIndex]
  const keys = stepKeys(problem, problemIndex)
  const statuses = keys.map((key) => stepStatus(progress, key))

  const feedbackIndex = feedback ? keys.indexOf(feedback.key) : -1
  const firstOpenStep = statuses.indexOf('open')
  const activeIndex = feedbackIndex >= 0 ? feedbackIndex : firstOpenStep >= 0 ? firstOpenStep : problem.steps.length
  const complete = activeIndex >= problem.steps.length

  const allKeys = problems.flatMap((item, index) => stepKeys(item, index))
  const solvedTotal = allKeys.filter((key) => progress.solved.includes(key)).length
  // A finished problem has changed what to do next on the topic: the card reads it again.
  const router = useRouter()
  const wasComplete = React.useRef(complete)
  React.useEffect(() => {
    if (complete && !wasComplete.current) React.startTransition(() => router.refresh())
    wasComplete.current = complete
  }, [complete, router])
  const underWay = feedback !== null || statuses.some((status) => status !== 'open') || keys.some((key) => progress.attempted.includes(key) || (progress.rungs[key] ?? 0) > 0)
  // Work under way (a step checked, a hint or the answer opened): the next-activity card waits. Once the student has begun it stays
  // away until every problem is done; it used to come back at the start of each problem and leave again at the first check.
  const [begun, setBegun] = React.useState(false)
  if (underWay && !begun) setBegun(true)
  const allDone = problems.every((item, index) => problemDone(progress, item, index))
  useActivityInProgress(begun && !allDone)
  // A problem with a step still to do is an attempt: on a phone the topic's header and path give way to a small bar with Exit.
  // The closing line of a problem (Problem complete) is a result, and keeps the whole path.
  useAttemptFocus(!complete)
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const aboutId = React.useId()

  // Once the student works on a problem it stays on screen when its last step is done, so its closing line and the choice of
  // the next problem are seen; without this the view would move on to the next open problem at once.
  const pin = () => setPicked((current) => current ?? problemIndex)

  function select(index: number) {
    setPicked(Math.max(0, Math.min(problems.length - 1, index)))
    setFeedback(null)
  }

  function onDontKnow(key: string) {
    pin()
    markDontKnow(key)
    setFeedback({ key, kind: 'idk' })
  }

  function onCheck(step: PracticeStep, key: string, answer: string) {
    const correct = checkPracticeAnswer(step, answer)
    pin()
    recordCheck(key, correct)
    setFeedback({ key, kind: correct ? 'correct' : 'incorrect' })
    return correct
  }

  return (
    <div className="flex max-w-[720px] flex-col">
      {rejected ? (
        <InlineAlert
          className="mb-4"
          tone="danger"
          title="That change could not be saved."
          action={
            <Button size="sm" variant="ghost" className="text-current" onClick={dismissRejected}>
              Dismiss
            </Button>
          }
        >
          This page now shows your last saved progress.
        </InlineAlert>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <h2 className="min-w-0 flex-1 text-heading text-fg">
          {/* "Problem 1 of 1" says nothing and a pager over one problem goes nowhere: both only show when there is a choice. */}
          {problems.length > 1 ? (
            <>
              <span className="tabular text-fg-3">
                Problem {problemIndex + 1} of {problems.length}
              </span>
              <span className="text-fg-3">: </span>
            </>
          ) : null}
          <MathText>{problem.title}</MathText>
        </h2>
        {problems.length > 1 ? <ProblemSwitcher problems={problems} progress={progress} current={problemIndex} onSelect={select} /> : null}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Progress
          aria-label="Steps solved"
          className="flex-1"
          value={allKeys.length ? (solvedTotal / allKeys.length) * 100 : 0}
        />
        <span className="tabular whitespace-nowrap text-caption text-fg-3">
          {solvedTotal} of {allKeys.length} solved
        </span>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {problem.problem ? (
          <LazyMarkdown variant="question">
            {problem.problem}
          </LazyMarkdown>
        ) : null}
        {(problem.difficulty || problem.keyConcepts.length > 0 || problem.minutes || problem.sources.length > 0) && (
          <div>
            {/* The problem's kind, time and source are one folded row: the problem and its steps come first. */}
            <button
              type="button"
              aria-expanded={aboutOpen}
              aria-controls={aboutId}
              onClick={() => setAboutOpen((current) => !current)}
              className="-ml-1 inline-flex min-h-8 items-center gap-1.5 rounded-chip px-1 text-small text-fg-2 hover:text-fg max-sm:min-h-11"
            >
              About this problem
              <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', aboutOpen && 'rotate-180')} />
            </button>
            <div id={aboutId} hidden={!aboutOpen} className="mt-1 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {problem.difficulty ? (
                  <Badge tone={problem.difficulty === 'hard' ? 'warning' : 'neutral'}>
                    {problem.difficulty[0].toUpperCase() + problem.difficulty.slice(1)}
                  </Badge>
                ) : null}
                {problem.keyConcepts.map((concept) => (
                  <ConceptChip key={concept}>{concept}</ConceptChip>
                ))}
                {problem.minutes ? <span className="ml-1 text-caption text-fg-3">About {problem.minutes} min</span> : null}
              </div>
              <SourceLine sources={problem.sources} />
            </div>
          </div>
        )}
      </div>

      <ol className="mt-8 flex flex-col">
        {problem.steps.map((step, index) => {
          const key = keys[index]
          const status = statuses[index]
          const active = index === activeIndex
          const resolved = status !== 'open' && !active
          const last = index === problem.steps.length - 1
          return (
            <li
              key={key}
              aria-current={active ? 'step' : undefined}
              className={cn('relative flex gap-3', !last && 'pb-5')}
            >
              {last ? null : <span aria-hidden="true" className="absolute bottom-0 left-3 top-7 w-px bg-border" />}
              <div className="relative z-[1] bg-canvas">
                <StepMarker
                  status={active && feedback?.kind === 'correct' ? 'solved' : status}
                  active={active}
                  number={index + 1}
                />
              </div>
              <div className="min-w-0 flex-1 pt-px">
                {active ? (
                  <ActiveStep
                    key={key}
                    step={step}
                    feedback={feedback?.key === key ? feedback.kind : null}
                    isLast={last}
                    onCheck={(answer) => onCheck(step, key, answer)}
                    onDontKnow={() => onDontKnow(key)}
                    onTryAgain={() => setFeedback(null)}
                    onMissHelp={(help) => setHelps((current) => (current[key] === help ? current : { ...current, [key]: help }))}
                    attempted={progress.attempted.includes(key)}
                    missed={progress.missRungs[key] !== undefined}
                    rung={progress.rungs[key] ?? 0}
                    onHint={(rung) => {
                      pin()
                      markHinted(key, rung)
                    }}
                    onHelp={(rung) => {
                      pin()
                      markHinted(key, rung)
                    }}
                    tutorConfig={{ topicId, problemIndex, problemTitle: problem.title, stepIndex: index, stepKey: key }}
                    onReveal={() => {
                      pin()
                      markRevealed(key)
                      setFeedback({ key, kind: 'revealed' })
                    }}
                    onNext={() => setFeedback(null)}
                  />
                ) : resolved ? (
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="min-w-0 truncate text-small text-fg-2">
                      <span className="text-fg-3">Step {index + 1}</span>
                    </p>
                    <p className="max-w-[60%] truncate text-small font-medium text-fg">
                      {status === 'revealed' ? <span className="mr-1.5 font-normal text-fg-3">Answer shown</span> : null}
                      <MathText>{step.correctAnswer}</MathText>
                    </p>
                  </div>
                ) : (
                  <p className="text-small text-fg-3">Step {index + 1}</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {complete ? (
        <ProblemComplete
          topicId={topicId}
          courseId={courseId}
          problems={problems}
          problemIndex={problemIndex}
          problem={problem}
          solved={statuses.filter((status) => status === 'solved').length}
          helps={helps}
          last={lastProblemOf(progress, problem, problemIndex)}
          finished={problems.map((item, index) => problemDone(progress, item, index))}
          onStartOver={() => clear(keys, problemKey(problemIndex, problem.title))}
          onGo={select}
        />
      ) : null}
      {complete && keys.some((key) => progress.missRungs[key] !== undefined) ? (
        <TrippedUp
          key={problemKey(problemIndex, problem.title)}
          saved={progress.trippedUp[problemKey(problemIndex, problem.title)] ?? ''}
          onSave={(answer) => setTrippedUp(problemKey(problemIndex, problem.title), answer)}
        />
      ) : null}
      {/* "More practice" is here once, after the problem and everything it ends in: the problem is the first thing on the screen,
          and the action to write more is not offered above it while the student is still working. */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-small text-fg-2">
          {pluralize(problems.length, 'problem')}, {pluralize(allKeys.length, 'step')}
        </p>
        <GenerateOptions kind="practice" mode="more" submitLabel="Generate" focusPlaceholder="e.g. weighted graphs" align="end">
          <Button size="sm" variant="secondary" icon={<Plus />}>
            More practice
          </Button>
        </GenerateOptions>
      </div>
    </div>
  )
}

/**
 * The closing line of a problem (spec 18.6): what comes next follows how it went. After help, an I don't know or a shown
 * answer, an easier problem, or one worked through first; after a clean sweep, a harder one. A problem with nothing solved
 * says that is common, with a pointer to the pages.
 */
function ProblemComplete({
  topicId,
  courseId,
  problems,
  problemIndex,
  problem,
  solved,
  helps,
  last,
  finished,
  onStartOver,
  onGo,
}: {
  topicId: string
  courseId: string | null
  problems: PracticeProblem[]
  problemIndex: number
  problem: PracticeProblem
  solved: number
  helps: Record<string, HelpAfterMiss>
  last: ReturnType<typeof lastProblemOf>
  finished: boolean[]
  onStartOver: () => void
  onGo: (index: number) => void
}) {
  const next = nextPracticeProblem(
    problems.map((item, index) => ({ difficulty: item.difficulty, finished: finished[index] })),
    last
  )
  const target = next.index !== null ? problems[next.index] : null
  const harder = target !== null && !next.offerExample && last.allFirstTry && difficultyRank(target.difficulty) > difficultyRank(problem.difficulty)
  const easier = target !== null && !next.offerExample && (last.anyRung3 || last.idk || last.surrendered)
  const focus = problem.conceptIds[0] ?? problem.steps.flatMap((step) => step.conceptIds)[0] ?? null
  const exampleHref = courseId ? `/courses/${courseId}/topics/${topicId}?view=examples&fade=full${focus ? `&focus=${encodeURIComponent(focus)}` : ''}` : null
  // Nothing is left to practise: the topic goes on to its quiz. It is the one primary then, and "Start over" is the quiet choice beside it.
  // When a worked example is recommended first, that is said and offered, and the quiz stays as the plain way on.
  const finishedAll = next.index === null
  const quizHref = courseId ? `/courses/${courseId}/topics/${topicId}?view=quiz` : null
  return (
    <>
      <InlineAlert className="mt-6" tone="accent" title="Problem complete">
        <p>
          You solved {solved} of {problem.steps.length} steps.
          {easier ? ' The next problem is an easier one.' : ''}
          {finishedAll && next.offerExample && exampleHref ? ' A worked example first will help, then the quiz.' : ''}
          {finishedAll && !next.offerExample ? ' That is all the practice for this topic.' : ''}
        </p>
        {solved === 0 ? <NoneSolved topicId={topicId} problemIndex={problemIndex} problem={problem} helps={helps} /> : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          {next.index !== null ? (
            <Button size="sm" variant="primary" icon={<ArrowRight />} onClick={() => onGo(next.index as number)}>
              {harder ? 'A harder one' : 'Next problem'}
            </Button>
          ) : null}
          {finishedAll && quizHref && !next.offerExample ? (
            <Button asChild size="sm" variant="primary" icon={<ArrowRight />}>
              <Link href={quizHref} scroll={false} data-testid="practice-to-quiz">
                Continue to Quiz
              </Link>
            </Button>
          ) : null}
          {next.offerExample && exampleHref ? (
            <a
              href={exampleHref}
              className="inline-flex h-8 items-center rounded-control px-2 text-small font-medium text-current underline underline-offset-2 max-sm:h-11"
            >
              See one worked through first
            </a>
          ) : null}
          {finishedAll && quizHref && next.offerExample ? (
            <Button asChild size="sm" variant="ghost" className="text-current">
              <Link href={quizHref} scroll={false} data-testid="practice-to-quiz">
                Continue to Quiz
              </Link>
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="text-current" onClick={onStartOver}>
            Start over
          </Button>
        </div>
      </InlineAlert>
    </>
  )
}

/** "None of these came easily": the expected-miss line with the page where the first missed concept is covered, and a link to it. */
function NoneSolved({ topicId, problemIndex, problem, helps }: { topicId: string; problemIndex: number; problem: PracticeProblem; helps: Record<string, HelpAfterMiss> }) {
  const [read, setRead] = React.useState<HelpAfterMiss | null>(null)
  const known = Object.values(helps).flatMap((help) => help.pointers)
  const stepIndex = problem.steps.findIndex((step) => step.conceptIds.length > 0)
  React.useEffect(() => {
    // After a reload no step holds what it said: the server still knows, so ask it for the first step with concepts.
    if (known.length > 0 || stepIndex < 0) return
    let live = true
    const query = new URLSearchParams({ problemIndex: String(problemIndex), problemTitle: problem.title, stepIndex: String(stepIndex) })
    void fetch(`/api/topics/${topicId}/practice-tutor?${query}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ help?: HelpAfterMiss }>) : null))
      .then((body) => live && body?.help && setRead(body.help))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [known.length, stepIndex, topicId, problemIndex, problem.title])
  const pointer = [...known, ...(read?.pointers ?? [])][0]
  return (
    <div className="mt-1 flex flex-col gap-1">
      <ExpectedMiss surface="practice_none_solved" page={pointer?.page ?? null} />
      {pointer ? (
        <a href={pointer.href} className="underline underline-offset-2">
          Re-read {pointer.conceptName}
          {pointer.page !== null ? `, p. ${pointer.page}` : ''}
        </a>
      ) : null}
    </div>
  )
}
