'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'

/** A suggested link in the panel, as a question with Yes and No (spec §9; each with its tick or cross): the answer is the student's own and is kept. */
export function EdgeQuestion({ edgeId, text }: { edgeId: string; text: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState<'confirmed' | 'rejected' | null>(null)
  // The question for the statement, without its question mark, names the buttons.
  const statement = text.replace(/\?$/, '')

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
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-body text-fg">{text}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          icon={<Check weight="bold" />}
          aria-label={`Yes: ${statement}`}
          loading={pending === 'confirmed'}
          disabled={pending !== null}
          onClick={() => void answer('confirmed')}
        >
          Yes
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<X weight="bold" />}
          aria-label={`No: ${statement}`}
          loading={pending === 'rejected'}
          disabled={pending !== null}
          onClick={() => void answer('rejected')}
        >
          No
        </Button>
      </span>
    </div>
  )
}
