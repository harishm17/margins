'use client'

import * as React from 'react'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { DAILY_MINUTE_CHOICES, dailyMinutesProblem, minutesLabel } from '@/lib/learning/plan-settings'

type ExamDateFieldProps = {
  /** YYYY-MM-DD, or an empty string for none. */
  examDate: string
  onExamDate: (value: string) => void
  error?: string | null
}

/** The exam date, optional: the plan counts back from it, and without one it covers the next two weeks. */
export function ExamDateField({ examDate, onExamDate, error }: ExamDateFieldProps) {
  return (
    <Field label="Exam date" optional hint="Margins plans your days up to it." error={error}>
      <Input name="examDate" type="date" value={examDate} onChange={(event) => onExamDate(event.target.value)} />
    </Field>
  )
}

const CUSTOM = 'custom'

type DailyTimeFieldProps = {
  dailyMinutes: number
  onDailyMinutes: (value: number) => void
}

/**
 * How long the student studies on a typical day. The presets cover most people; "Custom..." opens a minutes box for the rest.
 * Either way the value is the same whole number of minutes, used as an average budget for every day. An empty or out-of-range
 * custom value is passed on as NaN and said in words under the box, so the form that holds it can refuse to save it
 * (`dailyMinutesProblem`).
 */
export function DailyTimeField({ dailyMinutes, onDailyMinutes }: DailyTimeFieldProps) {
  const preset = (DAILY_MINUTE_CHOICES as readonly number[]).includes(dailyMinutes)
  // Once "Custom..." was picked it stays picked while the number is typed, even when the number passes through a preset.
  const [customPicked, setCustomPicked] = React.useState(false)
  const [text, setText] = React.useState(String(Number.isFinite(dailyMinutes) ? dailyMinutes : ''))
  const custom = customPicked || (!preset && Number.isFinite(dailyMinutes))
  const problem = custom ? dailyMinutesProblem(dailyMinutes) : null
  return (
    <div className="flex flex-col gap-3">
      <Field label="Typical daily study time" hint="Used for every day. You can change it later.">
        <Select
          name="dailyMinutes"
          value={custom ? CUSTOM : String(dailyMinutes)}
          onValueChange={(value) => {
            if (value === CUSTOM) {
              setCustomPicked(true)
              setText(String(Number.isFinite(dailyMinutes) ? dailyMinutes : ''))
              return
            }
            setCustomPicked(false)
            onDailyMinutes(Number(value))
          }}
          options={[
            ...DAILY_MINUTE_CHOICES.map((minutes) => ({ value: String(minutes), label: minutesLabel(minutes) })),
            { value: CUSTOM, label: 'Custom...' },
          ]}
        />
      </Field>
      {custom ? (
        <Field label="Minutes a day" hint="An average. Some days will be shorter." error={problem}>
          <Input
            name="customDailyMinutes"
            type="number"
            inputMode="numeric"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              onDailyMinutes(event.target.value.trim() === '' ? Number.NaN : Number(event.target.value))
            }}
            containerClassName="w-40"
          />
        </Field>
      ) : null}
    </div>
  )
}

type PlanFieldsProps = {
  examDate: string
  dailyMinutes: number
  onExamDate: (value: string) => void
  onDailyMinutes: (value: number) => void
  error?: string | null
  /** Names the group ("Study plan") for the pages where the two fields stand among others. */
  heading?: string
}

/** The two things the study plan needs: when the exam is, and how long you can study each day. */
export function PlanFields({ examDate, dailyMinutes, onExamDate, onDailyMinutes, error, heading }: PlanFieldsProps) {
  const fields = (
    <div className="grid gap-5 sm:grid-cols-2">
      <ExamDateField examDate={examDate} onExamDate={onExamDate} error={error} />
      <DailyTimeField dailyMinutes={dailyMinutes} onDailyMinutes={onDailyMinutes} />
    </div>
  )
  if (!heading) return fields
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 text-body-strong text-fg">{heading}</legend>
      {fields}
    </fieldset>
  )
}
