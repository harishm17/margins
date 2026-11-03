'use client'

import * as React from 'react'
import { CaretDown, CheckCircle, ListNumbers, Plus } from '@phosphor-icons/react/dist/ssr'
import { SourceLine } from '@/components/learning/source-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { MathText } from '@/components/ui/math-text'
import { fadeFor, hiddenSteps, hidesWhy, type FadeLevel } from '@/lib/learning/fade'
import { pluralize } from '@/lib/format'
import type { CheckGrade } from '@/lib/reader/checks'
import { cn } from '@/lib/utils'
import { CompletionRow } from './completion-row'
import { ConceptChip } from './concept-chip'
import { AttemptFirst, type FadedState } from './faded-step'
import { GenerateOptions } from './generation-ui'
import { useCheckGrader } from './use-check-grader'
import { useMarkComplete } from './use-mark-complete'
import type { ExamplesContent, SolvedExample, SolvedStep } from './types'

type FadedControls = {
  /** Steps (0-based) the student predicts before they show. */
  hidden: number[]
  /** Whether each step's "why" waits for the student's guess. */
  hideWhy: boolean
  level: FadeLevel
  /** What the student has done with each hidden part, by key (`step-2`, `why-0`). */
  done: Record<string, FadedState>
  /** The predictions typed so far, by key. */
  drafts: Record<string, string>
  onDraft: (key: string, text: string) => void
  onReveal: (key: string, idk: boolean) => void
  onGrade: (key: string, question: string, conceptIds: string[], grade: CheckGrade) => Promise<void>
}

function StepText({ step, index, example, fade }: { step: SolvedStep; index: number; example: SolvedExample; fade: FadedControls }) {
  const whyKey = `why-${index}`
  return (
    <>
      {step.description ? (
        <p className="text-body-strong text-fg">
          <span className="sr-only">Step {index + 1}: </span>
          <MathText>{step.description}</MathText>
        </p>
      ) : null}
      {step.work ? <LazyMarkdown variant="compact" className="mt-2">{step.work}</LazyMarkdown> : null}
      {step.explanation && fade.hideWhy ? (
        <div className="mt-3">
          <AttemptFirst
            title="Why this step? Write your guess"
            inputLabel="Your guess"
            placeholder="Write why you think this step is done"
            revealLabel="Show why"
            state={fade.done[whyKey]}
            text={fade.drafts[whyKey] ?? ''}
            onText={(text) => fade.onDraft(whyKey, text)}
            onReveal={(idk) => fade.onReveal(whyKey, idk)}
            onGrade={(grade) => fade.onGrade(whyKey, `Why does step ${index + 1} of the worked example "${example.title}" come next?`, step.conceptIds, grade)}
          >
            <LazyMarkdown variant="compact" className="text-small! text-fg-2!">
              {step.explanation}
            </LazyMarkdown>
          </AttemptFirst>
        </div>
      ) : step.explanation ? (
        <LazyMarkdown variant="compact" className="mt-2 text-small! text-fg-2!">
          {step.explanation}
        </LazyMarkdown>
      ) : null}
    </>
  )
}

function StepTimeline({ example, visible, fade }: { example: SolvedExample; visible: number; fade: FadedControls }) {
  // Steps stop at the first hidden one the student has not yet predicted: what comes after it waits for them.
  const stop = example.steps.findIndex((_, index) => fade.hidden.includes(index) && !fade.done[`step-${index}`])
  const shownCount = stop === -1 ? visible : Math.min(visible, stop + 1)
  return (
    <ol className="flex flex-col">
      {example.steps.slice(0, shownCount).map((step, index) => {
        const last = index === Math.min(shownCount, example.steps.length) - 1
        const key = `step-${index}`
        const predicting = fade.hidden.includes(index)
        return (
          <li key={`${step.number}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
            {last ? null : <span aria-hidden="true" className="absolute bottom-0 left-3 top-7 w-px bg-border" />}
            <span
              aria-hidden="true"
              className="relative z-[1] grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-caption text-fg-2 tabular"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 pt-px">
              {predicting ? (
                <AttemptFirst
                  title={fade.level === 'problem_first' ? `Step ${index + 1}: your next move` : 'Predict the next step'}
                  inputLabel="Your prediction"
                  placeholder="Write what you think comes next"
                  revealLabel="Show step"
                  state={fade.done[key]}
                  text={fade.drafts[key] ?? ''}
                  onText={(text) => fade.onDraft(key, text)}
                  onReveal={(idk) => fade.onReveal(key, idk)}
                  onGrade={(grade) => fade.onGrade(key, `What is step ${index + 1} of the worked example "${example.title}"? ${example.problem}`, step.conceptIds, grade)}
                >
                  <StepText step={step} index={index} example={example} fade={fade} />
                </AttemptFirst>
              ) : (
                <StepText step={step} index={index} example={example} fade={fade} />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** What the example asks of the student, in a few words (draft copy, spec 18.6): how much of it is worked for them. */
function levelCaption(level: FadeLevel, hidden: number): string {
  if (level === 'full') return 'Fully worked'
  if (level === 'problem_first') return 'Your turn first'
  return hidden === 1 ? 'One step left for you' : `${hidden} steps left for you`
}

/** The self-grades of the hidden parts the student has opened so far: an "I don't know" counts as Missed (spec 18.6). */
function gradesOf(done: Record<string, FadedState>): CheckGrade[] {
  return Object.values(done).flatMap((state) => (state.idk ? ['missed' as const] : state.grade ? [state.grade] : []))
}

function ExampleCard({
  topicId,
  example,
  index,
  open,
  onToggle,
  stepMode,
  shown,
  onShowNext,
  level,
  focusConceptId,
  onGrades,
  onEngage,
  onGrade,
}: {
  topicId: string
  example: SolvedExample
  index: number
  open: boolean
  onToggle: () => void
  stepMode: boolean
  shown: number
  onShowNext: () => void
  /** This example's level: from the start level and the grades of the examples before it, fixed once the student has begun this one. */
  level: FadeLevel
  /** The concept the next activity opened the examples for: a full example viewed with it is instruction. */
  focusConceptId?: string | null
  /** The grades given on this example so far, for the levels of the examples after it. */
  onGrades: (index: number, grades: CheckGrade[]) => void
  /** The student began this example: its level stays as it is, whatever they grade on the others. */
  onEngage: (index: number, level: FadeLevel) => void
  onGrade: (input: { question: string; grade: CheckGrade; idk: boolean; conceptIds: string[] }) => Promise<boolean>
}) {
  const panelId = React.useId()
  const [done, setDone] = React.useState<Record<string, FadedState>>({})
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const grades = gradesOf(done)
  const gradeList = grades.join(',')
  const begun = Object.keys(done).length > 0 || Object.values(drafts).some((text) => text.trim() !== '')
  React.useEffect(() => {
    onGrades(index, gradeList ? (gradeList.split(',') as CheckGrade[]) : [])
  }, [gradeList, index, onGrades])
  React.useEffect(() => {
    if (begun) onEngage(index, level)
  }, [begun, index, level, onEngage])
  // A full example the student is looking at, on a concept the next activity sent them to, is the idea shown to them (spec 18.5):
  // an instruction event, once a day. Without it the examples would be offered again for the same gap.
  const posted = React.useRef(false)
  React.useEffect(() => {
    if (!open || level !== 'full' || !focusConceptId || posted.current) return
    posted.current = true
    void fetch(`/api/topics/${topicId}/instruction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'worked_example', conceptIds: [focusConceptId], ref: `${focusConceptId}:examples:${index}` }),
    }).catch(() => undefined)
  }, [open, level, focusConceptId, topicId, index])
  const fade: FadedControls = {
    hidden: hiddenSteps(level, index, example.steps.length),
    hideWhy: hidesWhy(level, index),
    level,
    done,
    drafts,
    onDraft: (key, text) => setDrafts((current) => ({ ...current, [key]: text })),
    onReveal: (key, idk) => setDone((current) => ({ ...current, [key]: { idk, grade: null, recorded: true } })),
    onGrade: async (key, question, conceptIds, grade) => {
      const recorded = await onGrade({ question, grade, idk: done[key]?.idk ?? false, conceptIds })
      setDone((current) => ({ ...current, [key]: { idk: current[key]?.idk ?? false, grade, recorded } }))
    },
  }
  const visible = stepMode ? Math.min(example.steps.length, Math.max(1, shown)) : example.steps.length
  const pending = fade.hidden.some((step) => step < visible && !done[`step-${step}`])
  const allShown = visible >= example.steps.length && !fade.hidden.some((step) => !done[`step-${step}`])

  return (
    <Card className="p-0">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
          className="flex w-full items-center gap-3 rounded-card px-5 py-4 text-left"
        >
          <span className="tabular text-body-strong text-fg-3">{index + 1}</span>
          <span className="min-w-0 flex-1 text-subheading text-fg">
            <MathText>{example.title}</MathText>
          </span>
          {example.difficulty ? (
            <Badge tone={example.difficulty === 'hard' ? 'warning' : 'neutral'}>
              {example.difficulty[0].toUpperCase() + example.difficulty.slice(1)}
            </Badge>
          ) : null}
          <CaretDown
            aria-hidden="true"
            className={cn('size-4 shrink-0 text-fg-3 transition-transform duration-180', open && 'rotate-180')}
          />
        </button>
      </h2>
      {open ? (
        <div id={panelId} className="flex flex-col gap-6 border-t border-border px-5 pb-5 pt-5">
          {example.problem ? (
            <LazyMarkdown variant="reading" className="text-[16px]! leading-[27px]!">
              {example.problem}
            </LazyMarkdown>
          ) : null}

          {example.steps.length > 0 ? (
            <section aria-label={`Solution: ${example.title}`}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-subheading text-fg">Solution</h3>
                <span className="text-caption text-fg-3">{levelCaption(level, fade.hidden.length)}</span>
              </div>
              {level === 'problem_first' ? (
                <p className="mb-3 text-small text-fg-2">Try it first. Write your next move, then the step opens.</p>
              ) : fade.hidden.length > 0 ? (
                <p className="mb-3 text-small text-fg-2">Write a guess for the hidden step, then check it.</p>
              ) : fade.hideWhy ? (
                <p className="mb-3 text-small text-fg-2">Every step is shown. Write your guess for why before you read it.</p>
              ) : null}
              <StepTimeline example={example} visible={visible} fade={fade} />
              {stepMode && visible < example.steps.length && !pending ? (
                <Button className="mt-4" size="sm" variant="secondary" onClick={onShowNext}>
                  Show next step
                </Button>
              ) : null}
            </section>
          ) : null}

          {example.finalAnswer && allShown ? (
            <section aria-label={`Answer: ${example.title}`} className="rounded-card bg-accent-soft p-4 text-accent-soft-fg">
              <h3 className="mb-1.5 flex items-center gap-2 text-subheading">
                <CheckCircle aria-hidden="true" weight="fill" className="size-4" />
                Answer
              </h3>
              <LazyMarkdown variant="compact" className="text-accent-soft-fg!">
                {example.finalAnswer}
              </LazyMarkdown>
            </section>
          ) : null}

          {example.keyConcepts.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-small text-fg-2">Key concepts</span>
              {example.keyConcepts.map((concept) => (
                <ConceptChip key={concept}>{concept}</ConceptChip>
              ))}
            </div>
          ) : null}

          <SourceLine sources={example.sources} />
        </div>
      ) : null}
    </Card>
  )
}

type ExamplesViewProps = {
  topicId: string
  examples: ExamplesContent
  completed: boolean
  nextHref: string
  /** The first example's level (spec §5.5, §18.6): from the topic band, or `?fade=` when the next activity asks for full support. */
  level: FadeLevel
  /** `?focus=<conceptId>`: the concept the next activity opened the examples for. Used for instruction events in phase 2. */
  focusConceptId?: string | null
}

/** Worked examples as disclosure cards, with an optional step-by-step reveal. */
export function ExamplesView({ topicId, examples, completed, nextHref, level, focusConceptId }: ExamplesViewProps) {
  const items = examples.items
  const [openIds, setOpenIds] = React.useState<number[]>([0])
  const [stepMode, setStepMode] = React.useState(false)
  const [shown, setShown] = React.useState<Record<number, number>>({})
  // Each example's level follows the self-grades given so far (spec 18.6): one Missed or "I don't know" on the example before
  // moves it towards more support, all Got it on each of the two before moves it towards less. It is recomputed as the student
  // grades, and fixed for an example once they have begun it.
  const [gradesBy, setGradesBy] = React.useState<Record<number, CheckGrade[]>>({})
  const [fixed, setFixed] = React.useState<Record<number, FadeLevel>>({})
  const setGrades = React.useCallback(
    (index: number, grades: CheckGrade[]) =>
      setGradesBy((current) => (current[index]?.join(',') === grades.join(',') || (!current[index] && grades.length === 0) ? current : { ...current, [index]: grades })),
    []
  )
  const fix = React.useCallback((index: number, at: FadeLevel) => setFixed((current) => (current[index] ? current : { ...current, [index]: at })), [])
  const levelOf = (index: number): FadeLevel => fixed[index] ?? fadeFor(level, Array.from({ length: index }, (_, earlier) => gradesBy[earlier] ?? []))
  const { completed: isCompleted, saving, mark } = useMarkComplete(topicId, 'examplesCompleted', completed)
  const gradeCheck = useCheckGrader(topicId)

  const toggle = (index: number) =>
    setOpenIds((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]))

  return (
    <div className="max-w-[720px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-small text-fg-2">{pluralize(items.length, 'example')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<ListNumbers />}
            aria-pressed={stepMode}
            onClick={() => setStepMode((current) => !current)}
          >
            {stepMode ? 'Show all steps' : 'Step by step'}
          </Button>
          <GenerateOptions
            kind="examples"
            mode="more"
            submitLabel="Generate"
            focusPlaceholder="e.g. problems with cycles"
            align="end"
          >
            <Button size="sm" variant="secondary" icon={<Plus />}>
              More examples
            </Button>
          </GenerateOptions>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {items.map((example, index) => (
          <ExampleCard
            key={`${index}-${example.title}`}
            topicId={topicId}
            example={example}
            index={index}
            open={openIds.includes(index)}
            onToggle={() => toggle(index)}
            stepMode={stepMode}
            shown={shown[index] ?? 1}
            onShowNext={() => setShown((current) => ({ ...current, [index]: (current[index] ?? 1) + 1 }))}
            level={levelOf(index)}
            focusConceptId={focusConceptId}
            onGrades={setGrades}
            onEngage={fix}
            onGrade={async (input) => (await gradeCheck({ ...input, conceptId: null }))?.recorded === true}
          />
        ))}
      </div>

      <CompletionRow
        completed={isCompleted}
        saving={saving}
        markLabel="Mark as done"
        doneText="You've worked through these examples."
        nextHref={nextHref}
        nextLabel="Next: Practice"
        onMark={mark}
      />
    </div>
  )
}
