'use client'

import * as React from 'react'
import { Trash } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { MathText } from '@/components/ui/math-text'
import type { DetachedNoteView } from '@/lib/reader/detached-notes'

type Props = {
  /** The list's heading, e.g. "Notes from removed files". */
  heading: string
  /** One sentence under the heading saying why the notes are here. */
  description?: string
  notes: DetachedNoteView[]
  /** Deletes one note on the server; the list drops it once this resolves. A rejection leaves the note and shows an error. */
  onDelete: (id: string) => Promise<void>
  /** A stable id for the heading, when a page shows two lists. */
  idPrefix?: string
}

/**
 * Notes that outlived what they were written on: shown with the quote they sat on and their text, each with Delete.
 * Nothing is shown for an empty list. Used for "Notes from removed files" (the topic's reader) and, at integration,
 * "Notes from removed topics" (the course page).
 */
export function DetachedNotes({ heading, description, notes, onDelete, idPrefix = 'detached-notes' }: Props) {
  const [gone, setGone] = React.useState<Set<string>>(() => new Set())
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const shown = notes.filter((note) => !gone.has(note.id))
  if (shown.length === 0) return null

  async function remove(note: DetachedNoteView) {
    setBusy(note.id)
    setError(null)
    try {
      await onDelete(note.id)
      setGone((current) => new Set(current).add(note.id))
    } catch {
      setError("Couldn't delete the note. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const headingId = `${idPrefix}-heading`
  return (
    <section aria-labelledby={headingId} className="mt-10 max-w-[680px] border-t border-border pt-6" data-testid={idPrefix}>
      <h2 id={headingId} className="text-subheading text-fg">
        {heading}
      </h2>
      {description ? <p className="mt-1 text-small text-fg-2">{description}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-small text-danger">
          {error}
        </p>
      ) : null}
      <ul className="mt-4 flex flex-col gap-4">
        {shown.map((note) => (
          <li key={note.id} className="rounded-card border border-border bg-surface-2 px-4 py-3">
            {note.quote ? (
              <blockquote className="line-clamp-4 border-l-2 border-border-strong pl-3 text-small text-fg-3">
                <MathText>{note.quote}</MathText>
              </blockquote>
            ) : null}
            <p className="mt-2 whitespace-pre-wrap text-body text-fg">{note.text}</p>
            {note.reply ? <p className="mt-2 whitespace-pre-wrap text-small text-fg-2">{note.reply}</p> : null}
            <div className="mt-2 flex items-center justify-between gap-3">
              <time dateTime={note.createdAt} className="text-caption text-fg-3">
                {new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </time>
              <Button
                size="sm"
                variant="ghost"
                className="text-fg-2"
                icon={<Trash />}
                loading={busy === note.id}
                disabled={busy !== null && busy !== note.id}
                onClick={() => void remove(note)}
                aria-label={`Delete note: ${note.text.slice(0, 40)}`}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
