'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'

/**
 * A suggested link in the panel, as a question whose two buttons say what they do (spec §9): the answer is the student's own
 * and is kept. It sits under "Edit connections", away from the study actions.
 */
export function EdgeQuestion({ edgeId, text }: { edgeId: string; text: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState<'confirmed' | 'rejected' | null>(null)

  async function answer(status: 'confirmed' | 'rejected') {
    if (pending) return
    setPending(status)
    try {
      await apiFetch(`/api/concept-edges/${edgeId}`, { method: 'PATCH', json: { status } })
      toast(status === 'confirmed' ? 'Link kept' : 'Link removed')
      React.startTransition(() => router.refresh())
    } catch (caught) {
      toast.error(isApiError(caught) ? caught.message : "Couldn't save that. Try again.")
      setPending(null)
    }
  }

  return (
    <div role="group" aria-label={text} className="flex flex-col gap-2">
      <p className="min-w-0 text-body text-fg">{text}</p>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon={<Check weight="bold" />}
          loading={pending === 'confirmed'}
          disabled={pending !== null}
          onClick={() => void answer('confirmed')}
        >
          Yes, keep link
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<X weight="bold" />}
          loading={pending === 'rejected'}
          disabled={pending !== null}
          onClick={() => void answer('rejected')}
        >
          No, remove link
        </Button>
      </span>
    </div>
  )
}
