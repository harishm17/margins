'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { PlanFields } from '@/features/courses/plan-fields'
import { Button } from '@/components/ui/button'
import { apiFetch, isApiError } from '@/lib/api/client'

/**
 * Asked once in setup, after the topics are confirmed and before the first topic: the day-by-day plan
 * depends on the exam date, and a student who skipped it when making the course would otherwise meet
 * it only as a slim line later. Saving gives the plan its end date; "Skip for now" closes the question
 * for good (the same flag as the "When is your exam?" line on the overview), and the date stays
 * available in the course settings.
 */
export function SetupPlanFields({ courseId, dailyMinutes }: { courseId: string; dailyMinutes: number }) {
  const router = useRouter()
  const [examDate, setExamDate] = React.useState('')
  const [minutes, setMinutes] = React.useState(dailyMinutes)
  const [pending, setPending] = React.useState<'save' | 'skip' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function patch(json: Record<string, unknown>, which: 'save' | 'skip') {
    setPending(which)
    setError(null)
    try {
      await apiFetch(`/api/projects/${courseId}`, { method: 'PATCH', json })
      router.refresh()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save that. Try again.')
      setPending(null)
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!examDate) {
      setError('Pick the day of your exam, or skip for now.')
      return
    }
    void patch({ examDate, dailyMinutes: minutes }, 'save')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Exam date and daily time" className="mt-3 flex flex-col gap-4 rounded-control bg-surface-2 px-4 py-4">
      <p className="text-small text-fg-2">
        <span className="font-medium text-fg">When is your exam?</span> The plan counts back from it and tells you if time is short.
      </p>
      <PlanFields examDate={examDate} dailyMinutes={minutes} onExamDate={setExamDate} onDailyMinutes={setMinutes} error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" loading={pending === 'save'} disabled={pending === 'skip'}>
          Save date and time
        </Button>
        <Button
          type="button"
          variant="ghost"
          loading={pending === 'skip'}
          disabled={pending === 'save'}
          onClick={() => void patch({ examPromptDismissed: true }, 'skip')}
        >
          Skip for now
        </Button>
      </div>
    </form>
  )
}
