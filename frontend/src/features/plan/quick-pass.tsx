'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { QUICK_PASS_MINUTES } from '@/lib/learning/plan'
import { setQuickPassAction } from '@/app/(app)/courses/[courseId]/plan/actions'

/** Copy drafts for Harish to review (spec 18.8). */
export const QUICK_PASS_LABEL = `Quick pass (about ${QUICK_PASS_MINUTES} minutes)`
export const QUICK_PASS_EXPLAINER = 'Quick pass: a warm-up and a quiz, then review what you miss. You can do the full topic later.'
export const QUICK_PASS_UNDO = 'Undo quick pass'

type Topic = { id: string; name: string }

/**
 * The choice that goes with "Time is short" (spec 18.8): for each topic that did not fit, a quick pass of about 20 minutes, and
 * for each topic already on a quick pass, a way to undo it. Choosing draws the plan again; the topics that now fit join it.
 * Each button names its topic, so a list of them is clear to a screen reader.
 */
export function QuickPass({ courseId, unplaced, quick }: { courseId: string; unplaced: Topic[]; quick: Topic[] }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function choose(topicId: string, on: boolean) {
    setBusy(topicId)
    setError(null)
    const result = await setQuickPassAction(courseId, topicId, on).catch(() => ({ ok: false as const, error: 'failed' as const }))
    if (!result.ok) setError('Could not change that. Try again.')
    else React.startTransition(() => router.refresh())
    setBusy(null)
  }

  const quickIds = new Set(quick.map((topic) => topic.id))
  const offered = unplaced.filter((topic) => !quickIds.has(topic.id))
  if (offered.length === 0 && quick.length === 0) return null

  return (
    <section aria-labelledby="quick-pass-heading" className="rounded-card border border-border bg-surface p-4" data-testid="quick-pass">
      <h2 id="quick-pass-heading" className="flex items-center gap-2 text-body-strong text-fg">
        <Lightning aria-hidden="true" className="size-4 text-fg-2" />
        Quick pass
      </h2>
      <p className="mt-1 text-small text-fg-2">{QUICK_PASS_EXPLAINER}</p>
      {error ? (
        <InlineAlert className="mt-3" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {offered.map((topic) => (
          <li key={topic.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 first:pt-0 last:pb-0">
            <Link href={`/courses/${courseId}/topics/${topic.id}`} className="min-w-0 text-small text-fg hover:underline max-sm:min-h-11 max-sm:leading-[2.75rem]">
              {topic.name}
            </Link>
            <Button size="sm" variant="secondary" loading={busy === topic.id} disabled={busy !== null} onClick={() => void choose(topic.id, true)} aria-label={`${QUICK_PASS_LABEL} for ${topic.name}`}>
              {QUICK_PASS_LABEL}
            </Button>
          </li>
        ))}
        {quick.map((topic) => (
          <li key={topic.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 first:pt-0 last:pb-0">
            <span className="min-w-0 text-small text-fg">
              <Link href={`/courses/${courseId}/topics/${topic.id}`} className="hover:underline">
                {topic.name}
              </Link>
              <span className="ml-2 rounded-chip bg-accent-soft px-1.5 text-caption text-accent-soft-fg">Quick pass</span>
            </span>
            <Button size="sm" variant="ghost" loading={busy === topic.id} disabled={busy !== null} onClick={() => void choose(topic.id, false)} aria-label={`${QUICK_PASS_UNDO} for ${topic.name}`}>
              {QUICK_PASS_UNDO}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
