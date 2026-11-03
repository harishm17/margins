'use client'

import * as React from 'react'
import { ArrowRight, Check, CaretDown, CaretLeft, CaretRight, Eye, Lightbulb, Question, XCircle } from '@phosphor-icons/react/dist/ssr'
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
  const helpId = React.useId()
  const tutor = useStepTutor(tutorConfig, { onHelp })
  const workingId = React.useId()
  const revealNoteId = React.useId()
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
  // The next hint to open, in order, once the step has an attempt.
  const nextHint = available.find((index) => !opened.includes(index) && canOpenHint(index as 0 | 1 | 2, attempted)) ?? null
  // After a miss the help is in view, not folded. A hint opened before any miss folds the rest behind one row.
  const helpFolded = opened.length > 0 && !missed && !missFeedback

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
          <LazyMarkdown variant="reading" className="text-[16px]! leading-[27px]!">
            {step.question}
          </LazyMarkdown>
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
        <InlineAlert tone="danger" title="Not quite" icon={<XCircle />}>
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

      {!locked && missed && tutor.help ? <HelpAfterMissNote help={tutor.help} /> : null}

      {!locked ? <TalkOffer tutor={tutor} working={working} /> : null}

      {!locked ? <TutorThread turns={tutor.turns} pending={tutor.pending} /> : null}

      {!locked && helpFolded ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={helpOpen}
            aria-controls={helpId}
            icon={<Question />}
            className="-ml-2.5"
            onClick={() => setHelpOpen((current) => !current)}
          >
            <span className="inline-flex items-center gap-1">
              Get help
              <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', helpOpen && 'rotate-180')} />
            </span>
          </Button>
        </div>
      ) : null}

      {!locked ? (
        <div id={helpId} hidden={helpFolded && !helpOpen} className="flex flex-col gap-4">
          {!feedback && available.length > 0 ? (
            <div role="group" aria-label="Hints" className="grid gap-2 sm:grid-cols-3">
              {available.map((index) => {
                const isOpen = opened.includes(index)
                // In order, so that the stored rung says every earlier hint was opened too.
                const waiting = (!isOpen && available.some((earlier) => earlier < index && !opened.includes(earlier))) || !canOpenHint(index as 0 | 1 | 2, attempted)
                return (
                  <Button
                    key={index}
                    variant="secondary"
                    size="sm"
                    icon={<Lightbulb />}
                    aria-pressed={isOpen}
                    disabled={waiting}
                    className="h-auto w-full max-w-full shrink items-start justify-start py-1.5 text-left max-sm:h-auto max-sm:min-h-11"
                    onClick={() => {
                      if (!isOpen) openHint(index)
                    }}
                  >
                    <span className="flex flex-col whitespace-normal">
                      <span>{HINT_KINDS[index].name}</span>
                      <span className="text-caption font-normal text-fg-2">
                        {HINT_KINDS[index].gives} ({hintCostCopy(index as 0 | 1 | 2, { attempted, failedFirstTry })})
                      </span>
                    </span>
                  </Button>
                )
              })}
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <label htmlFor={workingId} className="text-small text-fg-2">
                  Your working (optional)
                </label>
                {draftStatus && (working.trim() || answer.trim()) ? <span className="text-caption text-fg-3">{draftStatus}</span> : null}
              </div>
              <Textarea
                id={workingId}
                rows={2}
                value={working}
                placeholder="Write down how you are thinking about this step"
                onChange={(event) => changeWorking(event.target.value)}
              />
            </div>
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

      <div className="flex flex-wrap items-center gap-2">
        {!feedback ? (
          <>
            <Button type="submit" variant="primary" icon={<Check />} disabled={!answer.trim()}>
              Check
            </Button>
            {!attempted ? (
              <Button variant="secondary" onClick={dontKnow}>
                I don&apos;t know
              </Button>
            ) : null}
            <Button variant="ghost" icon={<Eye />} onClick={reveal} disabled={!canReveal} aria-describedby={revealNoteId}>
              Show answer
            </Button>
            {!canReveal ? (
              <span id={revealNoteId} className="text-caption text-fg-3">
                Check an answer first, or say you don&apos;t know.
              </span>
            ) : null}
          </>
        ) : null}
        {missFeedback ? (
          <>
            <Button ref={retryRef} variant="primary" onClick={tryAgain}>
              Try again
            </Button>
            {nextHint !== null ? (
              <Button
                variant="secondary"
                icon={<Lightbulb />}
                className="h-auto max-w-full shrink items-start py-1.5 text-left max-sm:h-auto max-sm:min-h-11"
                onClick={() => {
                  openHint(nextHint)
                  // The last hint has gone: put focus back on the way forward.
                  if (!available.some((index) => index !== nextHint && !opened.includes(index))) requestAnimationFrame(() => retryRef.current?.focus())
                }}
              >
                <span className="flex flex-col whitespace-normal">
                  <span>Next hint: {HINT_KINDS[nextHint].name}</span>
                  <span className="text-caption font-normal text-fg-2">{hintCostCopy(nextHint as 0 | 1 | 2, { attempted, failedFirstTry })}</span>
                </span>
              </Button>
            ) : null}
            <Button variant="ghost" icon={<Eye />} onClick={reveal}>
              Show answer
            </Button>
          </>
        ) : null}
        {locked ? (
          <Button ref={nextRef} variant="primary" onClick={onNext} icon={<ArrowRight />}>
            {isLast ? 'Finish' : 'Next step'}
          </Button>
        ) : null}
      </div>
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
