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
  onChange,
}: {
  value: number | undefined
  /** The level tapped, kept beside the value; without it (an older answer) the level is read from the value. */
  level?: ConfidenceId
  /** Options on the question (4 for multiple choice, 2 for true or false): a guess stores as chance level. */
  optionCount?: number
  /** The screen cannot go on without a choice (the warm-up): the hint says so instead of offering to skip. */
  required?: boolean
  onChange: (level: ConfidenceId, confidence: number) => void
}) {
  const labelId = React.useId()
  const selected = selectedConfidenceLevel(level, value, optionCount)
  return (
    <div className="mt-8" data-confidence-row="">
      <p id={labelId} className="text-small text-fg-2">
        How sure are you?
        {selected === '' ? <span className="text-fg-3">{required ? ' Tap one to go on.' : ' Tap one, or skip it.'}</span> : null}
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
  )
}

/** An optional box for the student's reasoning; the short-answer grader and the wrong-answer diagnosis read it. */
export function ThinkingBox({ value, onChange }: { value: string; onChange: (thinking: string) => void }) {
  const [open, setOpen] = React.useState(value.length > 0)
  const panelId = React.useId()
  return (
    <div className="mt-5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-8 items-center gap-1 rounded-chip text-small text-fg-2 hover:text-fg max-sm:min-h-11"
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
