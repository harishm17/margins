'use client'

import * as React from 'react'
import { CaretDown, Check } from '@phosphor-icons/react/dist/ssr'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { CONFIDENCE_LEVELS, CONFIDENCE_WORDS, confidenceValue, selectedConfidenceLevel, type ConfidenceId } from '@/lib/learning/calibration'
import type { PublicQuizQuestion } from '@/lib/learning/quiz-questions'
import { cn } from '@/lib/utils'

const LABELS = CONFIDENCE_WORDS

/** Options a guess is measured against: chance level is one over this. */
export const optionCountOf = (question: PublicQuizQuestion) =>
  question.question_type === 'true_false' ? 2 : question.options?.length || undefined

/**
 * One tap for how sure the student is, before the answer is checked. Optional: it never blocks
 * Next or Submit. The chosen level shows a check mark as well as the raised style.
 */
export function ConfidenceRow({
  value,
  level,
  optionCount,
  required,
  optional = true,
  defaultOpen = false,
  onChange,
}: {
  value: number | undefined
  /** The level tapped, kept beside the value; without it (an older answer) the level is read from the value. */
  level?: ConfidenceId
  /** Options on the question (4 for multiple choice, 2 for true or false): a guess stores as chance level. */
  optionCount?: number
  /** The screen cannot go on without a choice (the warm-up): the hint says so instead of offering to skip. */
  required?: boolean
  /** Shown as optional (the default): the label says so, and on a phone the row sits behind one "Confidence (optional)" chip until it is tapped or already answered. */
  optional?: boolean
  /** Skip the phone chip: the row sits inside a disclosure the screen already offers. */
  defaultOpen?: boolean
  onChange: (level: ConfidenceId, confidence: number) => void
}) {
  const labelId = React.useId()
  const selected = selectedConfidenceLevel(level, value, optionCount)
  const [expanded, setExpanded] = React.useState(defaultOpen)
  // A phone shows the chip first; once a level is chosen (or the row is required) the row itself stays visible.
  const collapsed = optional && !required && selected === '' && !expanded
  return (
    <div className="mt-8 max-sm:mt-5" data-confidence-row="">
      {collapsed ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="hidden min-h-11 items-center gap-1 rounded-chip text-small text-fg-2 underline decoration-border-strong decoration-1 underline-offset-[3px] hover:text-fg max-sm:inline-flex"
        >
          Confidence (optional)
          <CaretDown className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <div className={cn(collapsed && 'max-sm:hidden')}>
        <p id={labelId} className="text-small text-fg-2">
          How sure are you?{optional ? ' (optional)' : ''}
          {selected === '' && required ? <span className="text-fg-3"> Tap one to go on.</span> : null}
        </p>
        <SegmentedControl
          aria-labelledby={labelId}
          className="mt-2"
          value={selected}
          onValueChange={(id) => id && onChange(id, confidenceValue(id, optionCount))}
          options={CONFIDENCE_LEVELS.map((level) => ({
            value: level.id,
            label: (
              <span className="inline-flex items-center gap-1">
                {selected === level.id ? <Check weight="bold" className="size-3.5" aria-hidden /> : null}
                {LABELS[level.id]}
              </span>
            ),
          }))}
        />
      </div>
    </div>
  )
}

/** An optional box for the student's reasoning; the short-answer grader and the wrong-answer diagnosis read it. */
export function ThinkingBox({ value, onChange }: { value: string; onChange: (thinking: string) => void }) {
  const [open, setOpen] = React.useState(value.length > 0)
  const panelId = React.useId()
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-8 items-center gap-1 rounded-chip text-small text-fg-2 underline decoration-border-strong decoration-1 underline-offset-[3px] hover:text-fg max-sm:min-h-11"
      >
        Show your thinking
        <CaretDown className={cn('size-3.5 transition-transform duration-180', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div id={panelId} className="mt-2">
          <Textarea
            aria-label="Your thinking"
            placeholder="How did you get to your answer? Optional."
            value={value}
            maxLength={4000}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      ) : null}
    </div>
  )
}
