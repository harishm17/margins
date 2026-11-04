'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CaretDown } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { apiFetch, isApiError } from '@/lib/api/client'
import { track as trackEvent } from '@/lib/analytics/track'
import { DEFAULT_DAILY_MINUTES, dailyMinutesProblem } from '@/lib/learning/plan-settings'
import { DescriptionField } from './description-field'
import { DailyTimeField, ExamDateField } from './plan-fields'

export function NewCourseForm() {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [examDate, setExamDate] = React.useState('')
  const [dailyMinutes, setDailyMinutes] = React.useState<number>(DEFAULT_DAILY_MINUTES)
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement>(null)
  // The details stay shut until asked for, but a time that cannot be saved opens them so the reason is in view.
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setNameError('Give the course a name.')
      nameRef.current?.focus()
      return
    }
    setNameError(null)
    if (dailyMinutesProblem(dailyMinutes)) {
      setDetailsOpen(true)
      setError('Check the daily study time under More details.')
      return
    }
    setPending(true)
    try {
      const { project } = await apiFetch<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        json: {
          name: name.trim(),
          description: description.trim() || null,
          ...(examDate ? { examDate } : {}),
          dailyMinutes,
        },
      })
      trackEvent('course_created')
      router.push(`/courses/${project.id}`)
      // The sidebar and command palette read the course list in the layout.
      router.refresh()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not create the course. Try again.')
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field label="Course name" required error={nameError}>
        <Input
          ref={nameRef}
          name="name"
          autoFocus
          autoComplete="off"
          maxLength={200}
          placeholder="e.g. CS 161 Algorithms"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            // The reminder goes as soon as there is a name, not at the next submit.
            if (nameError && event.target.value.trim()) setNameError(null)
          }}
        />
      </Field>
      <ExamDateField examDate={examDate} onExamDate={setExamDate} />
      {/* The daily time has a sensible default and the description does nothing for the plan: both wait behind one line that
          says what is set, so the first screen is a name and, if known, a date. */}
      <details
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        className="group rounded-control border border-border"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-control px-3.5 py-2 text-small [&::-webkit-details-marker]:hidden">
          <span className="font-medium text-fg">More details</span>
          <span className="flex items-center gap-1.5 text-fg-2">
            {Number.isFinite(dailyMinutes) ? `${dailyMinutes} min a day` : 'Daily time needs a number'}
            <CaretDown aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-180" />
          </span>
        </summary>
        <div className="flex flex-col gap-5 px-3.5 pb-4 pt-2">
          <DailyTimeField dailyMinutes={dailyMinutes} onDailyMinutes={setDailyMinutes} />
          <DescriptionField value={description} onChange={setDescription} rows={2} maxLength={1000} />
        </div>
      </details>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={pending}>
            Create course
          </Button>
          <Button asChild variant="secondary">
            <Link href="/home">Cancel</Link>
          </Button>
        </div>
        <p className="text-caption font-normal text-fg-3">You add your files next. Everything here can be changed later.</p>
      </div>
    </form>
  )
}
