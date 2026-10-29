'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  buildPreferences,
  defaultForm,
  FOCUS_MAX,
  QUESTION_TYPES,
  validateForm,
  type DetailLevel,
  type Difficulty,
  type GenerateForm as FormState,
  type GenerateMode,
  type QuestionType,
} from './generate-preferences'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { useGeneration } from './topic-provider'
import type { ContentKind } from './types'

const DETAIL_OPTIONS: { value: DetailLevel; label: string }[] = [
  { value: 'brief', label: 'Brief' },
  { value: 'moderate', label: 'Standard' },
  { value: 'comprehensive', label: 'Detailed' },
]

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
]

const COUNT_OPTIONS = [2, 3, 5].map((value) => ({ value: String(value), label: String(value) }))
const QUESTION_COUNT_OPTIONS = [5, 10, 15].map((value) => ({ value: String(value), label: String(value) }))

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-fg">{label}</span>
      {children}
    </div>
  )
}

type GenerateFormProps = {
  kind: ContentKind
  mode: GenerateMode
  submitLabel: string
  /** Called after the job has started. */
  onStarted?: () => void
  /** A line above the options, e.g. what a replacement removes. */
  note?: React.ReactNode
  focusPlaceholder?: string
}

/**
 * The options for writing one kind of content, and the button that starts it. Used inside the
 * options popovers and the regenerate dialog. Errors from starting (AI unavailable, daily
 * budget) show above the button.
 */
export function GenerateForm({ kind, mode, submitLabel, onStarted, note, focusPlaceholder }: GenerateFormProps) {
  const { generate, starting, startError } = useGeneration(kind)
  const { blocked } = useAiStatus()
  const [form, setForm] = React.useState<FormState>(() => defaultForm(mode))
  const [showErrors, setShowErrors] = React.useState(false)
  const errors = validateForm(kind, form)
  const patch = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }))

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (errors.focus || errors.types) {
      setShowErrors(true)
      return
    }
    const started = await generate(mode, buildPreferences(kind, form, mode))
    if (started) onStarted?.()
  }

  const toggleType = (type: QuestionType, checked: boolean) =>
    patch({ types: checked ? [...form.types, type] : form.types.filter((item) => item !== type) })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {note ? <p className="text-small text-fg-2">{note}</p> : null}

      {kind === 'notes' ? (
        <Row label="Level of detail">
          <SegmentedControl
            aria-label="Level of detail"
            fullWidth
            options={DETAIL_OPTIONS}
            value={form.detail}
            onValueChange={(detail) => patch({ detail })}
          />
        </Row>
      ) : null}

      {kind === 'examples' || kind === 'practice' ? (
        <Row label={kind === 'examples' ? 'How many examples' : 'How many problems'}>
          <SegmentedControl
            aria-label="Count"
            fullWidth
            options={COUNT_OPTIONS}
            value={String(form.count)}
            onValueChange={(count) => patch({ count: Number(count) })}
          />
        </Row>
      ) : null}

      {kind === 'quiz' ? (
        <>
          <Row label="Questions">
            <SegmentedControl
              aria-label="Number of questions"
              fullWidth
              options={QUESTION_COUNT_OPTIONS}
              value={String(form.questionCount)}
              onValueChange={(questionCount) => patch({ questionCount: Number(questionCount) })}
            />
          </Row>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-small font-medium text-fg">Question types</legend>
            {QUESTION_TYPES.map((type) => (
              <Checkbox
                key={type.value}
                label={type.label}
                checked={form.types.includes(type.value)}
                onCheckedChange={(checked) => toggleType(type.value, checked === true)}
              />
            ))}
            {showErrors && errors.types ? (
              <p role="alert" className="text-caption font-normal text-danger-soft-fg">
                {errors.types}
              </p>
            ) : null}
          </fieldset>
        </>
      ) : null}

      {kind !== 'notes' ? (
        <>
          <Row label="Difficulty">
            <SegmentedControl
              aria-label="Difficulty"
              fullWidth
              options={DIFFICULTY_OPTIONS}
              value={form.difficulty}
              onValueChange={(difficulty) => patch({ difficulty })}
            />
          </Row>
          <Field label="What should they focus on?" optional error={showErrors ? errors.focus : undefined}>
            <Input
              autoComplete="off"
              maxLength={FOCUS_MAX}
              placeholder={focusPlaceholder ?? 'e.g. edge cases'}
              value={form.focus}
              onChange={(event) => patch({ focus: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      {startError ? <InlineAlert tone={startError.tone}>{startError.message}</InlineAlert> : null}

      <Button type="submit" variant="primary" loading={starting} disabled={!!blocked} fullWidth>
        {submitLabel}
      </Button>
    </form>
  )
}
