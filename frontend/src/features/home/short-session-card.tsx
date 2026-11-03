'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Timer } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { shortSessionLabel, type ShortSessionPlan } from '@/lib/learning/short-session'

/**
 * "Have 10 minutes?" (spec 18.8): one tap into a session that fits, on Home and on the Review page. What is offered
 * comes from `shortSessionPlan`; the button makes the session (a review of at most 6, a recall card, or a 4-question check)
 * and opens it. A recall card is just a link.
 */
export function ShortSessionCard({ courseId, plan, className }: { courseId: string; plan: ShortSessionPlan; className?: string }) {
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
      setError(isApiError(caught) ? caught.message : 'Could not start a short session. Try again.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <section
      aria-labelledby={`short-session-${courseId}`}
      data-testid="short-session"
      className={`flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between ${className ?? ''}`}
    >
      <div className="min-w-0">
        <h2 id={`short-session-${courseId}`} className="flex items-center gap-2 text-heading text-fg">
          <Timer aria-hidden="true" className="size-5 text-fg-2" />
          Have 10 minutes?
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
