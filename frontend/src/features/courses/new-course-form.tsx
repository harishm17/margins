'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, isApiError } from '@/lib/api/client'
import { track as trackEvent } from '@/lib/analytics/track'
import { DEFAULT_DAILY_MINUTES } from '@/lib/learning/plan-settings'
import { PlanFields } from './plan-fields'

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

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setNameError('Give the course a name.')
      nameRef.current?.focus()
      return
    }
    setNameError(null)
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
      <Field label="Course name" error={nameError}>
        <Input
          ref={nameRef}
          name="name"
          autoFocus
          autoComplete="off"
          maxLength={200}
          placeholder="e.g. CS 161 Algorithms"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Description" optional hint="What are you preparing for?">
        <Textarea
          name="description"
          rows={2}
          maxLength={1000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <PlanFields examDate={examDate} dailyMinutes={dailyMinutes} onExamDate={setExamDate} onDailyMinutes={setDailyMinutes} />
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          Create course
        </Button>
        <Button asChild variant="secondary">
          <Link href="/home">Cancel</Link>
        </Button>
      </div>
    </form>
  )
}
