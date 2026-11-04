'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Timer } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { SHORT_SESSION_NAME, shortSessionLabel, type ShortSessionPlan } from '@/lib/learning/short-session'

/** The label on the quick-practice start action (W3-12 puts it on the card; the Review page uses it too). */
export const QUICK_PRACTICE_START = 'Start quick practice'

/** Makes the quick practice session and opens it; `error` is what to show when it cannot. Shared by the card and the "nothing is due" screen. */
export function useStartShortSession(courseId: string) {
  const router = useRouter()
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function start() {
    setStarting(true)
    setError(null)
    try {
      const result = await apiFetch<{ kind: string; href?: string }>(`/api/projects/${courseId}/short-session`, { method: 'POST' })
      if (result.href) router.push(result.href)
      else setError('There is nothing short to do right now. Open the course to see what is next.')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not start quick practice. Try again.')
    } finally {
      setStarting(false)
    }
  }
  return { start, starting, error }
}

/**
 * Quick practice (spec 18.8): one tap into a session that fits, on Home and on the Review page. What is offered
 * comes from `shortSessionPlan`; the button makes the session (a review of at most 6, a recall card, or a short question check)
 * and opens it. A recall card is just a link. The line under the name is the one statement of how long it takes.
 */
export function ShortSessionCard({ courseId, plan, className }: { courseId: string; plan: ShortSessionPlan; className?: string }) {
  const { start, starting, error } = useStartShortSession(courseId)

  return (
    <section
      aria-labelledby={`short-session-${courseId}`}
      data-testid="short-session"
      className={`flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between ${className ?? ''}`}
    >
      <div className="min-w-0">
        <h2 id={`short-session-${courseId}`} className="flex items-center gap-2 text-heading text-fg">
          <Timer aria-hidden="true" className="size-5 text-fg-2" />
          {SHORT_SESSION_NAME}
        </h2>
        <p className="mt-1 text-small text-fg-2">{shortSessionLabel(plan)}</p>
        {error ? (
          <InlineAlert className="mt-3" tone="danger">
            {error}
          </InlineAlert>
        ) : null}
      </div>
      {plan.kind === 'recall' && plan.href ? (
        <Button asChild variant="secondary" className="shrink-0 self-start sm:self-center">
          <Link href={plan.href}>
            Start
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </Button>
      ) : (
        <Button variant="secondary" className="shrink-0 self-start sm:self-center" onClick={() => void start()} loading={starting}>
          <span className="inline-flex items-center gap-1.5">
            Start
            <ArrowRight aria-hidden="true" className="size-4" />
          </span>
        </Button>
      )}
    </section>
  )
}
