/**
 * Where review sessions and drills are opened (spec §7.4, §8.1). One place builds the address, so the
 * plan, the Review page, the topic page's "what comes next" and the concept map all link the same way.
 *
 * - no option: today's review, from every due concept of the course;
 * - `topicId`: the same, filtered to that topic's due concepts plus up to two from other topics;
 * - `conceptId`: a drill on one concept, with its weakest prerequisite (fix_misconception and
 *   prerequisite_drill open this).
 */
export function reviewSessionHref(courseId: string, options: { topicId?: string | null; conceptId?: string | null } = {}): string {
  const base = `/courses/${courseId}/review/session`
  if (options.conceptId) return `${base}?concept=${encodeURIComponent(options.conceptId)}`
  if (options.topicId) return `${base}?topic=${encodeURIComponent(options.topicId)}`
  return base
}
