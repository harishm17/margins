/**
 * What a review session asks the review-item job for (spec §7.4): the concepts `selectReviewItems` and
 * `closingRetests` found no fresh item for, as one request list per topic (one job per topic). A concept
 * reported twice for one mode is asked for once, so two reports of the same gap do not buy four items.
 */

import type { Difficulty, MissingItems, Mode } from './review-select'

/** The body of one request in the job's input: the concepts that need an item in this mode and difficulty. */
export type ReviewItemRequest = { conceptIds: string[]; mode: Mode; difficulty: Difficulty }

export function requestsByTopic(missing: MissingItems[]): Map<string, ReviewItemRequest[]> {
  // One entry per topic, concept and mode. Easy wins over another level: it is the opener's item, and the
  // body can use a second easy item as well as any other.
  const chosen = new Map<string, Map<string, { conceptId: string; mode: Mode; difficulty: Difficulty }>>()
  for (const group of missing) {
    const topic = chosen.get(group.topicId) ?? new Map()
    for (const conceptId of group.conceptIds) {
      const key = `${conceptId}\u0000${group.mode}`
      const seen = topic.get(key)
      if (!seen || (seen.difficulty !== 'easy' && group.difficulty === 'easy')) {
        topic.set(key, { conceptId, mode: group.mode, difficulty: group.difficulty })
      }
    }
    if (topic.size > 0) chosen.set(group.topicId, topic)
  }

  const byTopic = new Map<string, ReviewItemRequest[]>()
  for (const [topicId, entries] of chosen) {
    const requests: ReviewItemRequest[] = []
    for (const entry of entries.values()) {
      const existing = requests.find((r) => r.mode === entry.mode && r.difficulty === entry.difficulty)
      if (existing) existing.conceptIds.push(entry.conceptId)
      else requests.push({ conceptIds: [entry.conceptId], mode: entry.mode, difficulty: entry.difficulty })
    }
    byTopic.set(topicId, requests)
  }
  return byTopic
}
