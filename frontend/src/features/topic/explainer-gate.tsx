'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LockSimple } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { InlineAlert } from '@/components/ui/inline-alert'
import { apiFetch, isApiError } from '@/lib/api/client'
import { EXPLAINER_ESCAPE_LABEL } from '@/features/learning/expected-miss-copy'
import { useActivityInProgress } from './topic-provider'

/**
 * The explainer before a recall (spec §5.4): "Try recalling first." The way on is Start recall. A student who would
 * rather read an explanation now can open the explainer once they have read the topic; that is recorded as `asked`
 * ("I'd rather read an explanation now", spec 18.10). The server refuses the explainer's text until one of the two has happened.
 */
export function ExplainerGate({ topicId, recallHref, readHref, canUnlock }: { topicId: string; recallHref: string; readHref: string; canUnlock: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // The gate says what to do next (Start recall), so the topic's own "next" line steps aside rather than name another step above it.
  useActivityInProgress(true)

  async function unlock() {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/topics/${topicId}/explainer-unlock`, { method: 'POST' })
      React.startTransition(() => router.refresh())
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not open the explainer. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <EmptyState
      icon={<LockSimple />}
      title="Try Recall to get an explanation of your gaps"
      action={
        <Button asChild variant="primary">
          <Link href={recallHref} scroll={false}>
            Start recall
          </Link>
        </Button>
      }
      secondary={
        <div className="flex flex-col items-center gap-1.5">
          {canUnlock ? (
            <>
              <p className="text-center text-small text-fg-2">You have finished reading this topic.</p>
              <Button variant="link" className="text-center text-small [&>span]:overflow-visible [&>span]:whitespace-normal" loading={busy} onClick={() => void unlock()}>
                {EXPLAINER_ESCAPE_LABEL}
              </Button>
            </>
          ) : (
            // Not a disabled button with a reason under it: until the topic is read there is nothing to press, so the other way to the
            // explanation is a real link to the reading, with its requirement said once.
            <>
              <Button asChild variant="link" className="text-small">
                <Link href={readHref} scroll={false}>
                  Read the topic first
                </Link>
              </Button>
              <p className="text-center text-caption text-fg-3">Finishing the reading also opens the explanation.</p>
            </>
          )}
          {error ? (
            <InlineAlert tone="danger" className="mt-2 text-left">
              {error}
            </InlineAlert>
          ) : null}
        </div>
      }
    >
      Writing what you remember first is what makes an explanation stick.
    </EmptyState>
  )
}
