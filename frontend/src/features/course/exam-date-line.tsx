'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'

/**
 * The exam date, as one small line under the course's name while the course has none and the question was not closed: "No exam
 * date. Set exam date". It lives in the header because the date belongs to the course, and it takes one line instead of a card
 * of its own, so "Up next" is the first thing under the title. The date field and its two buttons open from the line. Saving
 * plans the days up to the date; "Not now" closes the line for good (it is remembered on the course, so it stays closed on every
 * device). A date given when the course was made means this never shows.
 */
export function ExamDateLine({ courseId, className }: { courseId: string; className?: string }) {
  const router = useRouter()
  const inputId = React.useId()
  const [date, setDate] = React.useState('')
  const [pending, setPending] = React.useState<'save' | 'dismiss' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hidden, setHidden] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const dateRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (open) dateRef.current?.focus()
  }, [open])

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
    <section role="region" aria-label="When is your exam?" className={cn('-mt-4 mb-6 flex flex-col gap-2', className)}>
      <p className="flex flex-wrap items-center gap-x-2 text-small text-fg-2">
        <span>No exam date.</span>
        {open ? null : (
          <Button type="button" variant="link" className="h-auto px-0 text-small max-sm:min-h-11" onClick={() => setOpen(true)}>
            Set exam date
          </Button>
        )}
      </p>
      {open ? (
        <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="sr-only">
            Exam date
          </label>
          <Input ref={dateRef} id={inputId} type="date" value={date} onChange={(event) => setDate(event.target.value)} containerClassName="w-44 max-sm:flex-1" />
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
          <p className="basis-full text-caption font-normal text-fg-3">The plan counts back from it and tells you if time is short.</p>
        </form>
      ) : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    </section>
  )
}
