/**
 * What the student is told when the exam that was written is not the exam they asked for: topics left out because there are no
 * pages to write from, or fewer questions than asked. Read from the finished job's result.
 */
export function examShortfallNotes(result: Record<string, unknown> | null | undefined, asked: number | null): string[] {
  if (!result) return []
  const notes: string[] = []
  const skipped = Array.isArray(result.skipped_topics) ? result.skipped_topics.filter((name): name is string => typeof name === 'string' && name !== '') : []
  if (skipped.length > 0) {
    notes.push(`Left out of the exam: ${skipped.join(', ')}. There are no pages to write questions from ${skipped.length === 1 ? 'for it' : 'for them'}.`)
  }
  const total = typeof result.total_questions === 'number' ? result.total_questions : null
  if (asked !== null && total !== null && total < asked) {
    notes.push(`Your exam has ${total} of the ${asked} questions you asked for.`)
  }
  return notes
}
