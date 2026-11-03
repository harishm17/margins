'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'

/**
 * A slim line under "Up next" while the course has no exam date and the line was not closed: it asks
 * once, in a row, and never outranks the next step. Saving plans the days up to the date; "Not now"
 * closes it for good (it is remembered on the course, so it stays closed on every device). A date given
 * when the course was made means this never shows.
 */
export function ExamPromptCard({ courseId, className }: { courseId: string; className?: string }) {
  const router = useRouter()
  const inputId = React.useId()
  const [date, setDate] = React.useState('')
  const [pending, setPending] = React.useState<'save' | 'dismiss' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hidden, setHidden] = React.useState(false)

  async function patch(body: Record<string, unknown>, which: 'save' | 'dismiss') {
    setPending(which)
    setError(null)
    try {
      await apiFetch(`/api/projects/${courseId}`, { method: 'PATCH', json: body })
      setHidden(true)
      router.refresh()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save that. Try again.')
      setPending(null)
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!date) {
      setError('Pick the day of your exam first.')
      return
    }
    void patch({ examDate: date }, 'save')
  }

  if (hidden) return null
  return (
    <section
      role="region"
      aria-label="When is your exam?"
      className={cn('flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3 lg:flex-row lg:flex-wrap lg:items-center lg:gap-4', className)}
    >
      <p className="min-w-0 flex-1 text-small text-fg-2">
        <span className="font-medium text-fg">No exam date yet.</span> Add one and Margins plans your days up to it, and tells you if time is short.
      </p>
      <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Exam date
        </label>
        <Input id={inputId} type="date" value={date} onChange={(event) => setDate(event.target.value)} containerClassName="w-44 max-sm:flex-1" />
        <Button type="submit" variant="secondary" loading={pending === 'save'} disabled={pending === 'dismiss'}>
          Save date
        </Button>
        <Button
          type="button"
          variant="ghost"
          loading={pending === 'dismiss'}
          disabled={pending === 'save'}
          onClick={() => void patch({ examPromptDismissed: true }, 'dismiss')}
        >
          Not now
        </Button>
      </form>
      {error ? (
        <div className="lg:basis-full">
          <InlineAlert tone="danger">{error}</InlineAlert>
        </div>
      ) : null}
    </section>
  )
}
