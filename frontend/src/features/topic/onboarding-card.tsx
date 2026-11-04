'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CaretDown, Lightbulb } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { cardSeenBefore, isCardClosed, markCardClosed, markCardOpen, rememberCardSeen, saveCardClosed, subscribeNever } from './onboarding-state'

/**
 * The one-time card on the first topic a student opens (spec §5): Margins asks for an attempt before it
 * helps. Closing it is remembered on the user (User.seenEffortIntroAt), so it stays closed on every device.
 * It hides at once, and stays hidden for the rest of this page session (per user) even when a page already
 * prefetched (with the card in it) is shown next; the server is then asked to render again. If saving
 * fails twice the card comes back with a short note, so closing it never silently does nothing.
 */
export function OnboardingCard({ userId }: { userId: string }) {
  const router = useRouter()
  const view = useTopicView()
  const [hidden, setHidden] = React.useState(isCardClosed(userId))
  const [failed, setFailed] = React.useState(false)
  // The first view of the card is whole; on later topic views it is one line that opens on a tap.
  const seenBefore = React.useSyncExternalStore(subscribeNever, () => cardSeenBefore(userId), () => false)
  const [open, setOpen] = React.useState(false)
  const textId = React.useId()
  React.useEffect(() => {
    rememberCardSeen(userId)
  }, [userId])
  const folded = seenBefore && !open
  const { inProgress } = useTopic()
  const gone = hidden || isCardClosed(userId)

  // The card has said what it came to say once the student is answering something: it closes itself then, with no page refresh in
  // the middle of their work (the next page is drawn without it).
  const answering = inProgress && !gone
  React.useEffect(() => {
    if (answering) close(true)
    // close() only reads the user and sets state; it is not a dependency of what starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answering])

  // Not over the voice lobby: the student is choosing a voice activity there, and the card keeps for the next view.
  if (gone || view === 'voice') return null

  function close(quiet = false) {
    markCardClosed(userId)
    setHidden(true)
    setFailed(false)
    void saveCardClosed(() => apiFetch('/api/me/effort-intro', { method: 'POST' })).then((saved) => {
      if (saved) {
        if (!quiet) router.refresh()
        return
      }
      markCardOpen(userId)
      setFailed(true)
      setHidden(false)
    })
  }

  return (
    <section
      aria-labelledby="effort-intro-heading"
      className={cn(
        'mb-2 flex items-center group-data-[attempt]/topic:max-sm:hidden justify-between gap-3 rounded-card border border-border bg-surface-2 px-3 py-2 sm:mb-4 sm:gap-6 sm:px-4 sm:py-3',
        folded && 'py-0.5 sm:py-1'
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Lightbulb aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h2 id="effort-intro-heading" className="min-w-0 text-body-strong text-fg">
              Margins asks you to try before it helps.
            </h2>
            {seenBefore ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={textId}
                aria-label={open ? 'Show less' : 'Show more'}
                onClick={() => setOpen((current) => !current)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-chip text-fg-3 hover:text-fg max-sm:-my-1 max-sm:size-11"
              >
                <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', open && 'rotate-180')} />
              </button>
            ) : null}
          </div>
          <p id={textId} hidden={folded} className="mt-0.5 text-small text-fg-2">
            It will feel slower than reading a summary. It sticks better.
          </p>
          {failed ? (
            <p role="alert" className="mt-1 text-small text-danger">
              Could not save that. Try again.
            </p>
          ) : null}
        </div>
      </div>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => close()}>
        Got it
      </Button>
    </section>
  )
}
