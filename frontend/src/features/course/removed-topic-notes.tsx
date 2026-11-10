'use client'

import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api/client'
import { pluralize } from '@/lib/format'
import { DetachedNotes } from '@/features/notes/detached-notes'
import type { DetachedNoteView } from '@/lib/reader/detached-notes'

/**
 * "Notes from removed topics": the margin notes whose topic was deleted (finding 78). The same list as the reader's
 * "Notes from removed files"; deleting goes through the course's route, which checks the owner.
 */
export function RemovedTopicNotes({ courseId, notes }: { courseId: string; notes: DetachedNoteView[] }) {
  const router = useRouter()
  return (
    <DetachedNotes
      heading="Notes from removed topics"
      description={`${pluralize(notes.length, 'note')} you wrote on topics that were deleted. They stay until you delete them.`}
      notes={notes}
      idPrefix="removed-topic-notes"
      onDelete={async (id) => {
        await apiFetch(`/api/projects/${courseId}/removed-topic-notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        router.refresh()
      }}
    />
  )
}
