/**
 * The topics a mock exam for this topic's unit covers: the unit's topics in course order, only the confirmed
 * ones once the course's topic list is confirmed (new topics waiting for review are not part of the path yet).
 * A topic outside every unit stands alone. One place, so the topic page, the course overview and Home all
 * link the new-exam form the same way.
 */
export function unitTopicIds(
  topics: { id: string; unitId: string | null; confirmed: boolean }[],
  topicId: string,
  listConfirmed: boolean
): string[] {
  const unitId = topics.find((item) => item.id === topicId)?.unitId ?? null
  if (!unitId) return [topicId]
  return topics.filter((item) => item.unitId === unitId && (!listConfirmed || item.confirmed)).map((item) => item.id)
}
