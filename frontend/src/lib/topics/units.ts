import { courseMastery } from '@/lib/mastery'

/**
 * Units group topics (a week, a chapter, a lecture group). Pure helpers shared by the server
 * queries, the sidebar, the topics list and the editor.
 *
 * Course order is `Topic.orderIndex`, global across units. It stays consistent with the grouped
 * view because every write that moves a topic or a unit renormalises it with `canonicalTopicOrder`:
 * units in `Unit.orderIndex` order, each with its topics in `orderIndex` order, then the topics that
 * have no unit (added by hand, or planned before units existed) in `orderIndex` order.
 */

export type UnitLike = { id: string; orderIndex: number }
export type TopicLike = { id: string; unitId: string | null; orderIndex: number }

export type UnitGroup<T extends TopicLike, U extends UnitLike> = {
  /** Null for the topics that belong to no unit: shown as a plain "Topics" group with no header. */
  unit: U | null
  topics: T[]
}

const byOrder = <T extends { orderIndex: number; id: string }>(a: T, b: T) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id)

/**
 * Topics grouped by unit, units in order. A course with no units is one group with `unit: null`,
 * which is how flat courses render today. Topics of no unit (or of a unit that is not in `units`)
 * come last in a `unit: null` group. Units with no topic are left out unless `includeEmpty`
 * (the editor shows them so a topic can be moved in).
 */
export function groupTopicsByUnit<T extends TopicLike, U extends UnitLike>(
  topics: readonly T[],
  units: readonly U[],
  options: { includeEmpty?: boolean } = {}
): UnitGroup<T, U>[] {
  const known = new Set(units.map((unit) => unit.id))
  const groups: UnitGroup<T, U>[] = []
  for (const unit of [...units].sort(byOrder)) {
    const members = topics.filter((topic) => topic.unitId === unit.id).sort(byOrder)
    if (members.length > 0 || options.includeEmpty) groups.push({ unit, topics: members })
  }
  const loose = topics.filter((topic) => !topic.unitId || !known.has(topic.unitId)).sort(byOrder)
  if (loose.length > 0 || groups.length === 0) groups.push({ unit: null, topics: loose })
  return groups
}

/** Topic ids in course order: units in order, each unit's topics, then the topics with no unit. */
export function canonicalTopicOrder(topics: readonly TopicLike[], units: readonly UnitLike[]): string[] {
  return groupTopicsByUnit(topics, units).flatMap((group) => group.topics.map((topic) => topic.id))
}

/** Mean mastery of a unit's topics with not-started ones counting as 0 (as for the course); null when empty. */
export function unitMastery(masteries: readonly (number | null | undefined)[]): number | null {
  return courseMastery([...masteries])
}

/** Keeps only prerequisite ids that name a topic in `topicIds` other than the topic itself. */
export function cleanPrerequisites(topicId: string, prerequisiteIds: readonly string[], topicIds: ReadonlySet<string>): string[] {
  return [...new Set(prerequisiteIds)].filter((id) => id !== topicId && topicIds.has(id))
}

/** True when following prerequisite links from `topicId` would reach `target` (a cycle if it is the topic itself). */
export function reachesPrerequisite(
  graph: ReadonlyMap<string, readonly string[]>,
  topicId: string,
  target: string
): boolean {
  const seen = new Set<string>()
  const stack = [...(graph.get(topicId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(graph.get(id) ?? []))
  }
  return false
}

/** The unit a failed add is retried into: the one it was typed for while it exists, else the current target. */
export function unitForRetry(unitId: string | null, existingUnitIds: readonly string[], fallback: string | null): string | null {
  return unitId && existingUnitIds.includes(unitId) ? unitId : fallback
}
