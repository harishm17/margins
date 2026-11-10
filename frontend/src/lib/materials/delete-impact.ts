/**
 * What deleting one file does to the student's work, in counts, for the Delete dialog (and the Replace paths, which delete
 * the old file): the notes on it that are kept, and the ideas taken only from it that leave recall checks.
 * The rules behind the counts are in `references.ts`.
 */

import type { Prisma } from '@prisma/client'

type Db = Pick<Prisma.TransactionClient, 'marginNote' | 'concept'>

export type DeleteImpact = {
  /** Margin notes and questions the student wrote on this file; they are kept. */
  notes: number
  /** Active ideas whose every claim is from this file: they have nothing to quote once it is gone. */
  ideas: number
}

export async function fileDeleteImpact(db: Db, material: { id: string; projectId: string }): Promise<DeleteImpact> {
  const [notes, ideas] = await Promise.all([
    db.marginNote.count({ where: { materialId: material.id } }),
    db.concept.count({
      where: {
        projectId: material.projectId,
        status: 'active',
        claims: { some: { materialId: material.id }, none: { materialId: { not: material.id } } },
      },
    }),
  ])
  return { notes, ideas }
}
