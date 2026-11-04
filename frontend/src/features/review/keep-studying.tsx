import * as React from 'react'
import { CaretRight } from '@phosphor-icons/react/dist/ssr'

/**
 * The extras on a Review page with nothing due (quick practice, optional focus, voice practice, the schedule, progress), behind one
 * closed disclosure. With nothing due the page says so, gives the next date, and stops; going on is the student's choice.
 */
export function KeepStudying({ children }: { children: React.ReactNode }) {
  return (
    <details className="group" data-testid="keep-studying">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-control border border-border bg-surface px-4 text-body-strong text-fg hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <CaretRight aria-hidden="true" className="size-4 text-fg-3 transition-transform duration-180 group-open:rotate-90" />
        Keep studying (optional)
      </summary>
      <div className="mt-6 flex flex-col gap-10">{children}</div>
    </details>
  )
}
