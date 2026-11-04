'use client'

import * as React from 'react'
import { ArrowRight, Check, CaretDown, CaretLeft, CaretRight, Eye, Lightbulb, MinusCircle, Question } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { MathText } from '@/components/ui/math-text'
import { QuestionRenderer } from '@/components/ui/question-renderer'
import { Textarea } from '@/components/ui/textarea'
import { ExpectedMiss } from '@/features/learning/expected-miss'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'
import { canOpenHint } from '@/lib/learning/help-policy'
import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import { AUTHORED_HINT_RUNG, availableHints } from '@/lib/learning/practice-evidence'
import { cn } from '@/lib/utils'
import { missNote, splitChoices } from './practice-check'
import { type PracticeProgress } from './practice-keys'
import { ConfirmPanel, TalkOffer, TutorActions, TutorThread, useStepTutor, type StepTutorConfig } from './practice-tutor'
import { useOptionalTopic } from './topic-provider'
import type { PracticeProblem, PracticeStep } from './types'
import { hintCostCopy, problemSolved, stepFailedFirstTry, type Feedback } from './practice-state'

/** The three authored hints, in ladder order. Each says what it costs before it is opened (spec §5.6). */
const HINT_KINDS = [
  { name: 'Locate', gives: 'Where to look' },
  { name: 'Connect', gives: 'Name the idea' },
  { name: 'Structure', gives: 'Show the general form' },
] as const

/**
 * An opened hint as one line (its name and what it gave), open to read it. The newest hint opens by itself;
 * earlier ones fold, so a few hints and a miss do not stack up into a wall.
 */
function OpenedHint({ index, text, expanded, onToggle }: { index: number; text: string; expanded: boolean; onToggle: () => void }) {
  const bodyId = React.useId()
  return (
    <div className="rounded-control border border-border bg-surface-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex min-h-9 w-full items-center gap-2 rounded-control px-3 py-1.5 text-left text-small text-fg max-sm:min-h-11"
      >
        <Lightbulb aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
        <span className="font-medium">Hint: {HINT_KINDS[index].name}</span>
        <span className="min-w-0 flex-1 truncate text-fg-3 max-sm:hidden">{HINT_KINDS[index].gives}</span>
        <CaretDown aria-hidden="true" className={cn('ml-auto size-3.5 shrink-0 text-fg-3 transition-transform duration-180', expanded && 'rotate-180')} />
      </button>
      <div id={bodyId} hidden={!expanded} className="px-3 pb-2.5">
        <LazyMarkdown variant="compact" className="text-small! text-fg-2!">
          {text}
        </LazyMarkdown>
      </div>
    </div>
  )
}

/** What a miss points to (spec 18.3): the pages where the concepts are covered, the short explanation, an easier step. Needs no model. */
function HelpAfterMissNote({ help }: { help: HelpAfterMiss }) {
  const { pointers, explainer, easierStep } = help
  if (pointers.length === 0 && !explainer && !easierStep) return null
  const linkClass = 'text-accent underline underline-offset-2 hover:text-accent-hover'
  return (
    <div className="rounded-control border border-border bg-surface-2 px-3.5 py-3 text-small text-fg-2">
      <p className="text-body-strong text-fg">Where to look</p>
      <ul className="mt-1 flex flex-col gap-1">
        {pointers.map((pointer) => (
          <li key={pointer.conceptId}>
            <a href={pointer.href} className={linkClass}>
              Re-read {pointer.conceptName}
              {pointer.page !== null ? `, p. ${pointer.page}` : ''}
            </a>
          </li>
        ))}
        {explainer ? (
          <li>
            <a href={explainer.href} className={linkClass}>
              {explainer.ready ? 'Read a short explanation' : 'Get a short explanation'}
            </a>
          </li>
        ) : null}
        {easierStep && easierStep.kind !== 'easier_problem' ? (
          <li>
            <a href={easierStep.href} className={linkClass}>
              {easierStep.label}
            </a>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

type StepDraft = { answer: string; working: string }

function parseStepDraft(raw: unknown): StepDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const { answer, working } = raw as Record<string, unknown>
  return typeof answer === 'string' && typeof working === 'string' ? { answer, working } : null
}

/** The question, the answer control for the step's type, Check, "I don't know" and the help that opens after a miss. */
export function ActiveStep({
  step,
  feedback,
  onCheck,
  onDontKnow,
  onTryAgain,
  onReveal,
  attempted,
  missed,
  rung,
  onHint,
  onNext,
  isLast,
  tutorConfig,
  onHelp,
  onMissHelp,
}: {
  step: PracticeStep
  feedback: Feedback['kind'] | null
  /** Records the check and says whether the answer was right. */
  onCheck: (answer: string) => boolean
  /** "I don't know": the step's first check, wrong. */
  onDontKnow: () => void
  onTryAgain: () => void
  onReveal: () => void
  /** The step has a checked answer, from this visit or an earlier one. */
  attempted: boolean
  /** The step has a recorded miss (a wrong check or an "I don't know"), from this visit or an earlier one: the help stays open. */
  missed: boolean
  /** The highest rung used on this step so far, from this visit or an earlier one. */
  rung: number
  /** A hint was opened at this rung (it is remembered, and the step then does not count towards the score). */
  onHint: (rung: number) => void
  onNext: () => void
  isLast: boolean
  tutorConfig: StepTutorConfig
  /** The tutor gave help up to this rung (a reply above orient, or the worked example): the step is recorded at its level. */
  onHelp: (rung: number) => void
  /** What to read after a miss, once the server has said (the problem's closing line uses it). */
  onMissHelp: (help: HelpAfterMiss) => void
}) {
  const [answer, setAnswer] = React.useState('')
  const [working, setWorking] = React.useState('')
  // Why the last check missed, when that can be told for certain from the answer itself.
  const [note, setNote] = React.useState<string | null>(null)
  // Hints the student opened or closed by hand; without a choice only the newest is open.
  const [toggled, setToggled] = React.useState<Record<number, boolean>>({})
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [workingOpen, setWorkingOpen] = React.useState(false)
  const helpId = React.useId()
  const tutor = useStepTutor(tutorConfig, { onHelp })
  const workingId = React.useId()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const nextRef = React.useRef<HTMLButtonElement>(null)
  const retryRef = React.useRef<HTMLButtonElement>(null)

  // The answer and the working are a draft that follows the student across reloads and devices (spec 18.7).
  const projectId = useOptionalTopic()?.courseId ?? null
  const draftKey = tutor.contentId ? `${tutor.contentId}:${tutorConfig.problemIndex}:${tutorConfig.stepIndex}` : null
  const draft = useServerDraft<StepDraft>('practice', draftKey, { projectId, parse: parseStepDraft })
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current || !draftKey || draft.status === 'loading') return
    seeded.current = true
    if (!draft.value) return
    const stored = draft.value
    // The draft arrives after the first render; what the student has typed since is kept.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAnswer((current) => current || stored.answer)
    setWorking((current) => current || stored.working)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [draft.status, draft.value, draftKey])
  const keep = (nextAnswer: string, nextWorking: string) => {
    if (!nextAnswer.trim() && !nextWorking.trim()) void draft.clear()
    else draft.set({ answer: nextAnswer, working: nextWorking })
  }
  const changeAnswer = (value: string) => {
    setAnswer(value)
    keep(value, working)
  }
  const changeWorking = (value: string) => {
    setWorking(value)
    keep(answer, value)
  }

  const missHelp = React.useRef(onMissHelp)
  React.useEffect(() => {
    missHelp.current = onMissHelp
  })
  React.useEffect(() => {
    if (tutor.help) missHelp.current(tutor.help)
  }, [tutor.help])

  // Options are stored with the step; content written before that has them in the question text.
  const choices =
    step.answerType !== 'multiple_choice'
      ? null
      : step.options.length >= 2
        ? { stem: step.question, options: step.options }
        : splitChoices(step.question)
  const locked = feedback === 'correct' || feedback === 'revealed'
  const missFeedback = feedback === 'incorrect' || feedback === 'idk'
  // Content from before hint rungs has the connect hint only. A hint is open once the step's stored
  // rung has reached it, so the hints stay open after a reload and the answer gate reads the same rung.
  const available = availableHints(step.hints)
  const opened = available.filter((index) => rung >= AUTHORED_HINT_RUNG[index])
  // Connect, Structure and Show answer wait for one attempt (spec 18.4); locate is open from the start.
  const canReveal = attempted
  const newest = opened.length > 0 ? Math.max(...opened) : -1
  const failedFirstTry = stepFailedFirstTry({ checks: tutor.checks, rung, dontKnow: tutor.dontKnow, twoOption: choices?.options.length === 2 })
  // The hint ladder is one button: the next hint in order. It is offered before the first check too (Locate is free) but
  // the later ones wait for an attempt and say so, instead of three cost-labelled buttons up front.
  const ladder = available.find((index) => !opened.includes(index)) ?? null
  const ladderOpen = ladder !== null && canOpenHint(ladder as 0 | 1 | 2, attempted)

  React.useEffect(() => {
    if (feedback === 'correct' || feedback === 'revealed') nextRef.current?.focus()
    else if (feedback === 'incorrect' || feedback === 'idk') retryRef.current?.focus()
  }, [feedback])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!answer.trim() || feedback) return
    const correct = onCheck(answer)
    setNote(correct ? null : missNote(step, answer))
    if (correct) void draft.clear()
    tutor.noteCheck(answer, correct)
  }

  function dontKnow() {
    if (feedback || attempted) return
    setNote(null)
    tutor.noteDontKnow()
    onDontKnow()
  }

  function tryAgain() {
    setAnswer('')
    keep('', working)
    onTryAgain()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function reveal() {
    tutor.noteReveal()
    void draft.clear()
    onReveal()
  }

  function openHint(index: number) {
    onHint(AUTHORED_HINT_RUNG[index])
    tutor.noteHint(index as 0 | 1 | 2)
  }

  const draftStatus = statusLabel(draft.status)
  // The working is one line under the answer until it is wanted (or already written). The help is folded behind one button
  // until the step has been missed or the tutor is in use; then it is in view, after the way on.
  const workingShown = workingOpen || working.trim() !== ''
  // After a miss the way on is two buttons: Try again and the next hint. Everything else (where to look, Show answer, the tutor)
  // is behind one "More help", so a wrong answer does not open a wall of options. It opens by itself once the tutor is in use.
  const helpForced = missed || missFeedback
  const helpShown = helpOpen || tutor.turns.length > 0 || tutor.pending !== null
  const hintButton =
    ladder === null ? null : (
      <Button
        variant="secondary"
        icon={<Lightbulb />}
        disabled={!ladderOpen}
        className="h-auto max-w-full shrink items-start justify-start py-1.5 text-left max-sm:h-auto max-sm:min-h-11"
        onClick={() => {
          openHint(ladder)
          // The last hint has gone and the step was missed: put focus back on the way forward.
          if (missFeedback && !available.some((index) => index !== ladder && !opened.includes(index))) requestAnimationFrame(() => retryRef.current?.focus())
        }}
      >
        <span className="flex flex-col whitespace-normal">
          <span>Next hint: {HINT_KINDS[ladder].name}</span>
          <span className="text-caption font-normal text-fg-2">
            {ladderOpen ? `${HINT_KINDS[ladder].gives} · ${hintCostCopy(ladder as 0 | 1 | 2, { attempted, failedFirstTry })}` : 'Opens after your first try'}
          </span>
        </span>
      </Button>
    )

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {choices ? (
        <QuestionRenderer
          question={{
            question_type: 'multiple_choice',
            question_text: choices.stem || 'Choose the answer.',
            options: choices.options,
            points: 0,
          }}
          value={answer}
          onChange={changeAnswer}
          disabled={!!feedback}
          showPoints={false}
        />
      ) : (
        <>
          <LazyMarkdown variant="question">{step.question}</LazyMarkdown>
          <Input
            ref={inputRef}
            aria-label="Your answer"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode={step.answerType === 'numeric' ? 'decimal' : 'text'}
            placeholder={step.answerType === 'multiple_choice' ? 'Type the letter or the answer' : 'Your answer'}
            value={answer}
            disabled={!!feedback}
            onChange={(event) => changeAnswer(event.target.value)}
            containerClassName="max-w-sm"
          />
        </>
      )}

      {!locked ? (
        <div className="-mt-2 flex flex-col gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={workingShown}
            aria-controls={workingId}
            className="-ml-2.5 self-start max-sm:min-h-11"
            onClick={() => setWorkingOpen((current) => !current)}
          >
            <span className="inline-flex items-center gap-1">
              Your working (optional)
              <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', workingShown && 'rotate-180')} />
            </span>
          </Button>
          <div id={workingId} hidden={!workingShown} className="flex flex-col gap-1.5">
            <Textarea
              rows={2}
              value={working}
              aria-label="Your working (optional)"
              placeholder="Write down how you are thinking about this step"
              onChange={(event) => changeWorking(event.target.value)}
            />
            {draftStatus && (working.trim() || answer.trim()) ? <span className="text-caption text-fg-3">{draftStatus}</span> : null}
          </div>
        </div>
      ) : null}

      {!feedback ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" icon={<Check />} disabled={!answer.trim()} disabledReason="Type an answer first.">
            Check
          </Button>
          {!attempted ? (
            <Button variant="secondary" onClick={dontKnow}>
              I don&apos;t know
            </Button>
          ) : null}
          {/* A step that has been missed keeps its next hint beside Check, as it had after the miss: the hint is the way on, the rest is behind More help. */}
          {missed && ladder !== null ? hintButton : null}
        </div>
      ) : null}

      {feedback === 'correct' ? (
        <InlineAlert tone="accent" title="Correct" className="items-start">
          <div className="flex flex-col gap-2 text-current">
            {step.feedbackCorrect ? (
              <LazyMarkdown variant="compact" className="text-current!">
                {step.feedbackCorrect}
              </LazyMarkdown>
            ) : null}
            {step.explanation ? (
              <LazyMarkdown variant="compact" className="text-current!">
                {step.explanation}
              </LazyMarkdown>
            ) : null}
          </div>
        </InlineAlert>
      ) : null}

      {feedback === 'correct' && rung >= 1 ? <ConfirmPanel tutor={tutor} /> : null}

      {feedback === 'incorrect' ? (
        // A wrong answer is part of practice, not an error: the amber of Recall's gaps and the quiet mark of the warm-up, not the red of a failure.
        <InlineAlert tone="warning" title="Not quite" icon={<MinusCircle weight="fill" />}>
          {step.feedbackIncorrect ? (
            <LazyMarkdown variant="compact" className="text-current!">
              {step.feedbackIncorrect}
            </LazyMarkdown>
          ) : (
            'That is not the answer. Try again, or look at the hint.'
          )}
          {note ? <p className="mt-1">{note}</p> : null}
          <div className="mt-1 empty:hidden">
            <ExpectedMiss surface="practice_miss" />
          </div>
        </InlineAlert>
      ) : null}

      {feedback === 'idk' ? (
        <InlineAlert title="That's okay">
          <p>Not knowing is a place to start. Look at where it is covered, or open a hint.</p>
          <div className="mt-1 empty:hidden">
            <ExpectedMiss surface="practice_miss" />
          </div>
        </InlineAlert>
      ) : null}

      {feedback === 'revealed' ? (
        <InlineAlert title="The answer is shown, so this step won't count as solved.">
          <p className="mt-1 text-body-strong text-fg">
            <MathText>{step.correctAnswer}</MathText>
          </p>
          {step.explanation ? (
            <LazyMarkdown variant="compact" className="mt-2 text-small! text-fg-2!">
              {step.explanation}
            </LazyMarkdown>
          ) : null}
        </InlineAlert>
      ) : null}

      {/* The way on comes straight after what just happened; the help (below) is for the next try, not in front of it. */}
      {missFeedback ? (
        <div className="flex flex-wrap items-start gap-2">
          <Button ref={retryRef} variant="primary" onClick={tryAgain}>
            Try again
          </Button>
          {ladder !== null ? hintButton : null}
        </div>
      ) : null}
      {locked ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={nextRef} variant="primary" onClick={onNext} icon={<ArrowRight />}>
            {isLast ? 'Finish' : 'Next step'}
          </Button>
        </div>
      ) : null}

      {!locked
        ? [...opened]
            .sort((a, b) => a - b)
            .map((index) => (
              <OpenedHint
                key={index}
                index={index}
                text={step.hints[index]}
                expanded={toggled[index] ?? index === newest}
                onToggle={() => setToggled((current) => ({ ...current, [index]: !(current[index] ?? index === newest) }))}
              />
            ))
        : null}

      {!locked ? <TalkOffer tutor={tutor} working={working} /> : null}

      {!locked ? <TutorThread turns={tutor.turns} pending={tutor.pending} /> : null}

      {!locked ? (
        <div className="flex flex-col gap-3">
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={helpShown}
              aria-controls={helpId}
              icon={<Question />}
              className="-ml-2.5 max-sm:min-h-11"
              onClick={() => setHelpOpen((current) => !current)}
            >
              <span className="inline-flex items-center gap-1">
                {helpForced ? 'More help' : 'Get help'}
                <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', helpShown && 'rotate-180')} />
              </span>
            </Button>
          </div>
          <div id={helpId} hidden={!helpShown} className="flex flex-col gap-3">
            {missed && tutor.help ? <HelpAfterMissNote help={tutor.help} /> : null}
            {ladder !== null && !missed && !missFeedback ? (
              <div role="group" aria-label="Hints" className="flex">
                {hintButton}
              </div>
            ) : null}
            {canReveal ? (
              <div>
                <Button variant="ghost" size="sm" icon={<Eye />} className="-ml-2.5 max-sm:min-h-11" onClick={reveal}>
                  Show answer
                </Button>
              </div>
            ) : null}
            <TutorActions
              tutor={tutor}
              working={working}
              failedFirstTry={failedFirstTry}
              onSent={() => {
                setWorking('')
                keep(answer, '')
              }}
            />
          </div>
        </div>
      ) : null}
    </form>
  )
}

/** After a problem with a wrong check: an optional line on what went wrong. Saved when the box loses focus. */
export function TrippedUp({ saved, onSave }: { saved: string; onSave: (answer: string) => void }) {
  const [draft, setDraft] = React.useState(saved)
  const id = React.useId()
  return (
    <div className="mt-4 flex max-w-md flex-col gap-1.5">
      <label htmlFor={id} className="text-small text-fg-2">
        What tripped you up? (optional)
      </label>
      <Input
        id={id}
        autoComplete="off"
        value={draft}
        maxLength={300}
        placeholder="One line is enough"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() !== saved && onSave(draft.trim())}
      />
    </div>
  )
}

export function StepMarker({ status, active, number }: { status: 'solved' | 'revealed' | 'open'; active: boolean; number: number }) {
  if (status === 'solved') {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-accent-fg">
        <Check weight="bold" className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Solved</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full border text-caption tabular',
        status === 'revealed' && 'border-border-strong bg-surface-2 text-fg-2',
        status === 'open' && active && 'border-accent text-accent ring-2 ring-accent/20',
        status === 'open' && !active && 'border-border text-fg-3'
      )}
    >
      {number}
    </span>
  )
}

export function ProblemSwitcher({
  problems,
  progress,
  current,
  onSelect,
}: {
  problems: PracticeProblem[]
  progress: PracticeProgress
  current: number
  onSelect: (index: number) => void
}) {
  return (
    <nav aria-label="Problems" className="flex items-center gap-1">
      <IconButton
        label="Previous problem"
        icon={<CaretLeft />}
        size="sm"
        disabled={current === 0}
        onClick={() => onSelect(current - 1)}
      />
      {problems.map((problem, index) => {
        const solved = problemSolved(progress, problem, index)
        return (
          <button
            key={`${index}-${problem.title}`}
            type="button"
            aria-label={`Problem ${index + 1}${solved ? ', solved' : ''}`}
            aria-current={index === current ? 'true' : undefined}
            onClick={() => onSelect(index)}
            className={cn(
              'grid h-7 min-w-7 place-items-center rounded-chip border px-1.5 text-small tabular transition-colors duration-120 max-sm:h-11 max-sm:min-w-11',
              index === current
                ? 'border-accent bg-accent-soft text-accent-soft-fg'
                : 'border-border text-fg-2 hover:border-border-strong hover:text-fg'
            )}
          >
            {solved ? <Check weight="bold" className="size-3.5" aria-hidden="true" /> : index + 1}
          </button>
        )
      })}
      <IconButton
        label="Next problem"
        icon={<CaretRight />}
        size="sm"
        disabled={current === problems.length - 1}
        onClick={() => onSelect(current + 1)}
      />
    </nav>
  )
}
