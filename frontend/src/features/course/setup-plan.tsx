'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { PlanFields } from '@/features/courses/plan-fields'
import { Button } from '@/components/ui/button'
import { apiFetch, isApiError } from '@/lib/api/client'

/**
 * The last step of setup, when the course has no exam date and the question was not closed: the exam date (optional)
 * and the daily time, and the one thing the step is for, starting the first topic. Saving and starting are one
 * action, so the time the student chose is never thrown away by the way out: "Save and start" keeps the date and
 * the time, "Start without a date" keeps the time and closes the date question for good (the same flag as the
 * "No exam date" line on the overview). The date stays available in the course settings.
 */
export function SetupStartForm({
  courseId,
  dailyMinutes,
  startHref,
  firstTopicName,
}: {
  courseId: string
  dailyMinutes: number
  /** The first topic, where the warm-up is; the topic list when there is none. */
  startHref: string
  firstTopicName: string | null
}) {
  const router = useRouter()
  const [examDate, setExamDate] = React.useState('')
  const [minutes, setMinutes] = React.useState(dailyMinutes)
  const [pending, setPending] = React.useState<'save' | 'skip' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function saveAndStart(withDate: boolean) {
    const which = withDate ? 'save' : 'skip'
    setPending(which)
    setError(null)
    try {
      // The exam date is optional: leaving it out saves the time alone. Either way the question is closed.
      await apiFetch(`/api/projects/${courseId}`, {
        method: 'PATCH',
        json: { dailyMinutes: minutes, examPromptDismissed: true, ...(withDate && examDate ? { examDate } : {}) },
      })
      router.push(startHref)
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save that. Try again.')
      setPending(null)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveAndStart(true)
      }}
      noValidate
      aria-label="Exam date and daily time"
      className="mt-3 flex flex-col gap-4 rounded-control bg-surface-2 px-4 pt-4 max-md:pb-0 md:pb-4"
    >
      <p className="text-small text-fg-2">
        <span className="font-medium text-fg">When is your exam?</span> If you know, the plan counts back from it and tells you if time is short.
        Without one, Margins plans the next two weeks.
      </p>
      <PlanFields examDate={examDate} dailyMinutes={minutes} onExamDate={setExamDate} onDailyMinutes={setMinutes} error={error} />
      {/* On a phone the way forward stays above the tab bar, so the first topic is never a scroll away. */}
      <div className="flex flex-col gap-2 max-md:sticky max-md:bottom-(--tabbar-height,0px) max-md:z-sticky max-md:-mx-4 max-md:border-t max-md:border-border max-md:bg-surface-2 max-md:px-4 max-md:py-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button type="submit" variant="primary" loading={pending === 'save'} disabled={pending === 'skip'} className="max-sm:w-full">
          {firstTopicName ? 'Save and start warm-up' : 'Save and open topics'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={pending === 'skip'}
          disabled={pending === 'save'}
          className="max-sm:w-full"
          onClick={() => void saveAndStart(false)}
        >
          Start without a date
        </Button>
      </div>
    </form>
  )
}
