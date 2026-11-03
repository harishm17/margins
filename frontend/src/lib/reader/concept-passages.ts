/**
 * Which passages of the reader hold a concept's claims (spec 18.5): the reader opened for an idea marks them "Focus here"
 * and scrolls to the first. Server only.
 */

import { prisma } from '@/lib/db/prisma'
import { loadTopicChunkRefs, resolveMergedChunks } from './load-reader'

/**
 * The ids of the passages the reader shows that hold a claim of this concept, in reading order, once each. A claim on a
 * chunk that is only the repeated tail of the one before it is on that one (the reader and the warm-up marks agree). The
 * concept must be an active concept of this topic, and the topic the student's; otherwise none.
 */
export async function conceptPassageIds(userId: string, topicId: string, conceptId: string): Promise<string[]> {
  const claims = await prisma.conceptClaim.findMany({
    where: { conceptId, concept: { topicId, status: 'active', topic: { project: { userId } } }, chunkId: { not: null } },
    select: { chunkId: true },
  })
  if (claims.length === 0) return []
  const refs = await loadTopicChunkRefs(topicId)
  const merged = await resolveMergedChunks(refs, claims.flatMap((claim) => (claim.chunkId ? [claim.chunkId] : [])))
  const wanted = new Set(claims.flatMap((claim) => (claim.chunkId ? [merged.get(claim.chunkId) ?? claim.chunkId] : [])))
  return refs.filter((ref) => wanted.has(ref.id)).map((ref) => ref.id)
}
