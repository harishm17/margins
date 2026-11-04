'use client'

import * as React from 'react'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { DAILY_MINUTE_CHOICES, minutesLabel } from '@/lib/learning/plan-settings'

type PlanFieldsProps = {
  /** YYYY-MM-DD, or an empty string for none. */
  examDate: string
  dailyMinutes: number
  onExamDate: (value: string) => void
  onDailyMinutes: (value: number) => void
  error?: string | null
}

/** The two things the study plan needs: when the exam is, and how long you can study each day. */
export function PlanFields({ examDate, dailyMinutes, onExamDate, onDailyMinutes, error }: PlanFieldsProps) {
  // A saved value outside the usual choices is still shown.
  const choices = [...new Set<number>([...DAILY_MINUTE_CHOICES, dailyMinutes])].sort((a, b) => a - b)
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Exam date" optional hint="Margins plans your days up to it." error={error}>
        <Input
          name="examDate"
          type="date"
          value={examDate}
          onChange={(event) => onExamDate(event.target.value)}
        />
      </Field>
      <Field label="Time to study each day" hint="Each day's plan is sized to this.">
        <Select
          name="dailyMinutes"
          value={String(dailyMinutes)}
          onValueChange={(value) => onDailyMinutes(Number(value))}
          options={choices.map((minutes) => ({ value: String(minutes), label: minutesLabel(minutes) }))}
        />
      </Field>
    </div>
  )
}
