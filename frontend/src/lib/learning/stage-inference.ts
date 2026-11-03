/**
 * The topic stages a student has reached, including the ones a topic read before v3 never recorded.
 *
 * A topic read before v3 has notesCompleted and no readAt. Its reading counts as read, and as recalled when there
 * is history to show it was studied (spec §8.2: before v3, notesCompleted is the learned signal). A topic with a
 * readAt was read in the reader, and its evidence may be only the warm-up's or the reader's own: no inference.
 * Pure: the next-activity selector and the explainer gate read the stages the same way.
 */

export type StageProgress = {
  notesCompleted: boolean
  readAt: Date | null
  recallAt: Date | null
  lastAccessedAt: Date | null
}

export function inferStages(progress: StageProgress | null, hasAnyEvidence: boolean): { readAt: Date | null; recallAt: Date | null } {
  const notesCompleted = progress?.notesCompleted === true
  const readAt = progress?.readAt ?? (notesCompleted ? (progress?.lastAccessedAt ?? new Date(0)) : null)
  const recallAt = progress?.recallAt ?? (notesCompleted && !progress?.readAt && hasAnyEvidence ? readAt : null)
  return { readAt, recallAt }
}
