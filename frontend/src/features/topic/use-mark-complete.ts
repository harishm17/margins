'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from '@/components/ui/toaster'
import { apiFetch } from '@/lib/api/client'
import { useTopic } from './topic-provider'

/**
 * "Mark as read", "I've read it" (the reader) and "Mark as done": flips to completed at once, saves through the progress
 * route, and rolls back with a toast if saving fails. On success the page is refreshed so the
 * tab glyph and the sidebar catch up. Marking the examples done also starts the next topic's
 * notes in the background, so they are ready when the student gets there.
 */
export function useMarkComplete(topicId: string, field: 'notesCompleted' | 'examplesCompleted' | 'readAt', initial: boolean) {
  const router = useRouter()
  const { prefetchNext } = useTopic()
  const [optimistic, setOptimistic] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const mark = React.useCallback(async () => {
    setOptimistic(true)
    setSaving(true)
    try {
      await apiFetch(`/api/topics/${topicId}/progress`, { method: 'POST', json: { [field]: true } })
      if (field === 'examplesCompleted') prefetchNext()
      React.startTransition(() => router.refresh())
    } catch {
      setOptimistic(false)
      toast.error("Couldn't save your progress. Try again.")
    } finally {
      setSaving(false)
    }
  }, [topicId, field, router, prefetchNext])

  return { completed: initial || optimistic, saving, mark }
}
