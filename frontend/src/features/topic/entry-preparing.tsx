'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Hourglass } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAiStatus } from '@/features/ai/ai-status'
import { useActivityInProgress, useAttemptFocus } from './topic-provider'

/** How often the page asks the server whether the topic is ready, and how long before the wait is called long. */
const POLL_MS = 2500
const LONG_WAIT_MS = 90_000

/**
 * The first screen of a topic the student has not started, while Margins writes its warm-up (the concepts come first, then
 * the questions). The path above keeps its five steps in place, so nothing moves underneath; when the warm-up is written
 * this screen sends the student to it, once, instead of leaving them on whatever step was ready first. Reading is a choice,
 * always one tap away: the reader works from the student's own pages and needs no preparation.
 *
 * `ready` is the server's answer (the topic is no longer being prepared); `target` is where the topic goes on from here.
 * `intro` is the one-time "try before it helps" message of a student's first topics: it is said here, in the panel that
 * is already explaining the wait, and the card that says the same above the page steps aside (an activity in progress closes it).
 */
export function EntryPreparing({ ready, target, readHref, intro = false }: { ready: boolean; target: string; readHref: string; intro?: boolean }) {
  const router = useRouter()
  useActivityInProgress(true)
  // On a phone the path of five steps, all marked as preparing, gives way to the small bar: the panel is the page.
  useAttemptFocus(true)
  const { blocked } = useAiStatus()
  const [long, setLong] = React.useState(false)

  React.useEffect(() => {
    if (ready) {
      router.replace(target, { scroll: false })
      return
    }
    const poll = window.setInterval(() => router.refresh(), POLL_MS)
    const slow = window.setTimeout(() => setLong(true), LONG_WAIT_MS)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(slow)
    }
  }, [ready, target, router])

  const stuck = !!blocked || long
  return (
    <div role="status" aria-live="polite" className="mx-auto flex max-w-[52ch] flex-col items-center px-4 py-10 text-center">
      <div aria-hidden="true" className="grid size-10 place-items-center rounded-card bg-surface-2 text-fg-2 [&>svg]:size-5">
        <Hourglass />
      </div>
      {/* The stage and the wait come first, in the heading: that is what the student is waiting on. The one-line reason follows. */}
      <h2 className="mt-4 inline-flex items-center gap-2 text-subheading text-fg">
        {ready || blocked ? null : <Spinner />}
        {ready ? 'Ready' : blocked ? 'Preparation is paused' : 'Writing your warm-up questions, about a minute'}
      </h2>
      {intro && !ready ? (
        <p className="mt-1.5 text-small text-fg" data-testid="entry-intro">
          Margins asks you to try before it helps.
        </p>
      ) : null}
      <p className="mt-1.5 text-small text-fg-2">
        {blocked
          ? `${blocked.text} You can read the topic now and come back for the warm-up.`
          : ready
            ? 'Opening the warm-up.'
            : long
              ? 'This is taking longer than usual. You can read the topic now; the warm-up will be waiting when it is written.'
              : 'The questions come before the reading, and the warm-up opens by itself.'}
      </p>
      {ready ? null : (
        <Button asChild variant={stuck ? 'primary' : 'secondary'} className="mt-5 max-sm:min-h-11">
          <Link href={readHref} scroll={false}>
            Start reading instead
            <ArrowRight aria-hidden="true" className="ml-1 size-4" />
          </Link>
        </Button>
      )}
    </div>
  )
}
