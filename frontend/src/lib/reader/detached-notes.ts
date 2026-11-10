/**
 * Margin notes whose place is gone: the file they were written on was deleted (material_id cleared), or the topic was
 * (topic_id cleared). The note is the student's own writing, so it stays with its text, the quote it sat on and the
 * tutor's reply, and is listed apart from the passages (lib/materials/references.ts, rule keep-and-mark).
 */

export type DetachedNoteView = {
  id: string
  kind: 'note' | 'question' | 'answer'
  text: string
  /** The passage the note sat on, copied when it was written; null for a note from before the quote was kept. */
  quote: string | null
  /** The tutor's reply to a question, or null. */
  reply: string | null
  createdAt: string
}

export function toDetachedNoteView(row: { id: string; kind: string; text: string; quote: string | null; reply: unknown; createdAt: Date }): DetachedNoteView {
  const stored = row.reply && typeof row.reply === 'object' && !Array.isArray(row.reply) ? (row.reply as Record<string, unknown>) : null
  return {
    id: row.id,
    kind: row.kind === 'question' || row.kind === 'answer' ? row.kind : 'note',
    text: row.text,
    quote: row.quote,
    reply: stored && typeof stored.reply === 'string' ? stored.reply : null,
    createdAt: row.createdAt.toISOString(),
  }
}
