'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'
import { pluralize } from '@/lib/format'

export type RemovedNote = { id: string; quote: string | null; text: string }

/**
 * "Notes from removed topics": the margin notes whose topic was deleted. The note keeps the passage it sat on and the
 * student's text, and can be deleted here (their own only; the route checks the owner).
 */
export function RemovedTopicNotes({ courseId, notes }: { courseId: string; notes: RemovedNote[] }) {
  const router = useRouter()
  const [deleting, setDeleting] = React.useState<RemovedNote | null>(null)
  if (notes.length === 0) return null

  async function remove() {
    if (!deleting) return
    try {
      await apiFetch(`/api/projects/${courseId}/removed-topic-notes?id=${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
    } catch (error) {
      toast.error(isApiError(error) ? error.message : "Couldn't delete the note. Try again.")
      throw error
    }
    toast.success('Note deleted')
    router.refresh()
  }

  return (
    <section aria-labelledby="removed-topic-notes" className="mt-10 flex flex-col gap-3">
      <div>
        <h2 id="removed-topic-notes" className="text-subheading text-fg">Notes from removed topics</h2>
        <p className="text-small text-fg-2">{pluralize(notes.length, 'note')} you wrote on topics that were deleted. They stay until you delete them.</p>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {notes.map((note) => (
          <li key={note.id} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              {note.quote ? <blockquote className="line-clamp-3 border-l-2 border-border pl-3 text-small text-fg-2">{note.quote}</blockquote> : null}
              <p className="mt-2 whitespace-pre-wrap text-body text-fg">{note.text}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setDeleting(note)}>Delete note</Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this note?"
        description="The note is deleted for good."
        confirmLabel="Delete note"
        destructive
        onConfirm={remove}
      />
    </section>
  )
}
