/** How many passages the reader marks Focus here for a finished warm-up. Server only. */

import { prisma } from '@/lib/db/prisma'
import { focusChunks } from '@/lib/learning/warmup-bracket'
import { latestWarmupResults, type WarmupState } from '@/lib/learning/warmup-session'
import { loadTopicChunkRefs, resolveMergedChunks } from './load-reader'

/** From the warm-up's results and the claims, resolved onto the passages the reader shows (merged chunks included), so it equals the reader's marks. */
export async function countFocusPassages(userId: string, topicId: string): Promise<number> {
  const results = await latestWarmupResults(userId, topicId)
  if (!results) return 0
  const [claims, refs] = await Promise.all([
    prisma.conceptClaim.findMany({ where: { concept: { topicId, status: 'active' } }, select: { conceptId: true, chunkId: true } }),
    loadTopicChunkRefs(topicId),
  ])
  const merged = await resolveMergedChunks(refs, claims.flatMap((claim) => (claim.chunkId ? [claim.chunkId] : [])))
  const reading = claims.map((claim) => ({ ...claim, chunkId: claim.chunkId ? merged.get(claim.chunkId) ?? claim.chunkId : null }))
  // A resolved id is never a merged-away chunk, so it is shown when it is in the list at all.
  const shown = new Set(refs.map((ref) => ref.id))
  return focusChunks(results, reading).filter((id) => shown.has(id)).length
}

/** A finished warm-up with its focus count; any other state as it is. */
export async function withFocusCount(userId: string, topicId: string, state: WarmupState) {
  if (state.status !== 'done') return state
  return { ...state, focusCount: await countFocusPassages(userId, topicId) }
}
