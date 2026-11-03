import { prisma } from '@/lib/db/prisma'
import { rebuildConcepts } from './evidence'
import { withTransactionRetry } from './transaction-retry'

/**
 * The student's answer to a suggested link between two concepts (spec §9, D15). A link is course data that
 * belongs to the student's own course, so only its owner can change it.
 *
 * Confirming marks the link as the student's and makes the link count in full. Rejecting hides it and, for an
 * encompasses link, takes back the implicit credit it gave this student: every implicit event whose path walked the
 * link (`metadata.pathEdgeIds`, or `edgeId` on events written before paths were recorded) is deleted, and the concepts
 * they reached are replayed from what is left.
 *
 * Rejecting and confirming are not inverses: confirming a link again later does not bring back credit that a
 * rejection removed. Credit is only given for answers that come after the link counts.
 *
 * The status change, the delete and the replay are one transaction under the reached concepts' locks. recordEvidence
 * reads the links again under the same locks and holds them (FOR SHARE) until it commits, so an answer written while
 * the student rejects either finishes first (and is cleaned up here) or sees the link as rejected.
 */
export type EdgeAnswer = 'confirmed' | 'rejected'

export type EdgeAnswerResult = { status: 'not_found' } | { status: 'ok'; removedCredit: number }

/** Test seam: runs inside the transaction after the status is written (a failure there undoes the status). */
export type EdgeAnswerHooks = { afterStatusWritten?: () => Promise<void> }

class ReachedMore extends Error {}

const MAX_ROUNDS = 5

export async function setEdgeStatus(
  input: { userId: string; edgeId: string; status: EdgeAnswer; timeZone: string },
  hooks: EdgeAnswerHooks = {}
): Promise<EdgeAnswerResult> {
  const { userId, edgeId, status, timeZone } = input
  const edge = await prisma.conceptEdge.findFirst({
    where: { id: edgeId, project: { userId } },
    select: { id: true, type: true },
  })
  if (!edge) return { status: 'not_found' }
  const write = { where: { id: edge.id }, data: { status, origin: 'student' } }

  if (status === 'confirmed' || edge.type !== 'encompasses') {
    await prisma.conceptEdge.update(write)
    return { status: 'ok', removedCredit: 0 }
  }

  const throughEdge = {
    userId,
    source: 'implicit',
    OR: [{ metadata: { path: ['pathEdgeIds'], array_contains: edge.id } }, { metadata: { path: ['edgeId'], equals: edge.id } }],
  }
  const reachedBy = (db: Pick<typeof prisma, 'evidenceEvent'>) => db.evidenceEvent.findMany({ where: throughEdge, select: { conceptId: true }, distinct: ['conceptId'] })

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const known = new Set((await reachedBy(prisma)).map((row) => row.conceptId))
    let removedCredit = 0
    // Under the locks (or, with nothing reached yet, inside one transaction) the status is written, which waits for any
    // answer still being recorded; the credit is then looked for again, and if it reached concepts that were not locked
    // the round is run again with them.
    const inside = async (tx: Pick<typeof prisma, 'conceptEdge' | 'evidenceEvent'>) => {
      await tx.conceptEdge.update(write)
      await hooks.afterStatusWritten?.()
      const now = await reachedBy(tx)
      if (now.some((row) => !known.has(row.conceptId))) throw new ReachedMore()
      removedCredit = (await tx.evidenceEvent.deleteMany({ where: throughEdge })).count
    }
    try {
      if (known.size === 0) await withTransactionRetry(() => prisma.$transaction(inside))
      else await rebuildConcepts(userId, [...known], timeZone, inside)
      return { status: 'ok', removedCredit }
    } catch (error) {
      if (!(error instanceof ReachedMore)) throw error
    }
  }
  throw new Error('The credit of a link kept changing while it was being removed')
}
