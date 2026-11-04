'use client'

import * as React from 'react'
import { Check, Eye } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { CheckGrade } from '@/lib/reader/checks'

const GRADES: { id: CheckGrade; label: string }[] = [
  { id: 'got_it', label: 'Got it' },
  { id: 'partly', label: 'Partly' },
  { id: 'missed', label: 'Missed' },
]

const DONT_KNOW = "I don't know"

/** What the student has done with one hidden part of an example: absent while hidden, then revealed, then graded. */
export type FadedState = { idk: boolean; grade: CheckGrade | null; /** False when the grade was kept on screen only (graded before, or no concept to file it under). */ recorded: boolean }

type AttemptFirstProps = {
  /** What is hidden, in words: "Predict the next step", "Why this step? Write your guess". */
  title: string
  inputLabel: string
  placeholder: string
  revealLabel: string
  state: FadedState | undefined
  /** The student's prediction so far; kept by the screen, so it survives the example being closed. */
  text: string
  onText: (text: string) => void
  onReveal: (idk: boolean) => void
  /** Saves the student's own grade (level 2); throws when it could not be saved. */
  onGrade: (grade: CheckGrade) => Promise<void>
  /** The hidden part, shown after the student has written their attempt. */
  children: React.ReactNode
}

/**
 * One hidden part of a faded worked example (spec §5.5), attempt-first like a check block: the student writes a
 * prediction, or taps "I don't know", before the part shows. Then they grade themselves with Got it, Partly or Missed.
 */
export function AttemptFirst({ title, inputLabel, placeholder, revealLabel, state, text, onText, onReveal, onGrade, children }: AttemptFirstProps) {
  const id = React.useId()
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const attempted = text.trim().length > 0

  async function grade(value: CheckGrade) {
    if (saving || !state) return
    setSaving(true)
    setError(null)
    try {
      await onGrade(value)
    } catch {
      setError('Could not save that. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!state) {
    return (
      <div role="group" aria-labelledby={`${id}-title`}>
        <p id={`${id}-title`} className="text-body-strong text-fg">
          {title}
        </p>
        <label htmlFor={`${id}-text`} className="mb-1 mt-2 block text-caption text-fg-3">
          {inputLabel}
        </label>
        <Textarea
          id={`${id}-text`}
          rows={2}
          maxRows={6}
          maxLength={2000}
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder={placeholder}
          aria-describedby={attempted ? undefined : `${id}-hint`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={<Eye />} disabled={!attempted} onClick={() => onReveal(false)}>
            {revealLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onReveal(true)}>
            {DONT_KNOW}
          </Button>
          {attempted ? null : (
            <span id={`${id}-hint`} className="text-caption text-fg-3">
              Write a guess, or tap &ldquo;{DONT_KNOW}&rdquo;, to see it.
            </span>
          )}
        </div>
      </div>
    )
  }

  const choices = state.idk ? GRADES.filter((item) => item.id === 'missed') : GRADES
  return (
    <div>
      {children}
      <div className="mt-3">
        {state.grade ? (
          <p role="status" className="flex items-center gap-1.5 text-small text-fg-2">
            <Check aria-hidden="true" weight="bold" className="size-4 shrink-0 text-accent" />
            {state.recorded ? 'Saved' : 'Noted, not counted'}: {GRADES.find((item) => item.id === state.grade)?.label}
          </p>
        ) : (
          <div role="group" aria-label="How did you do?" className="flex flex-wrap items-center gap-2">
            <span className="text-small text-fg-2">How did you do?</span>
            {choices.map((item) => (
              <Button key={item.id} size="sm" variant="secondary" disabled={saving} onClick={() => void grade(item.id)}>
                {item.label}
              </Button>
            ))}
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-small text-danger-soft-fg">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
