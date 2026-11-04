import { pluralize } from '@/lib/format'
import { countMasteryLevels, type MasteryLevel } from '@/lib/mastery'

/**
 * The status line on an active course card: the topic count plus the most advanced mastery
 * bucket that has any topics in it: "2 strong", else "1 getting there", else "1 learning".
 * A bucket with no topics is never named, so there is no "0 strong".
 */
export function activeStatusLine(levels: MasteryLevel[]): string {
  const counts = countMasteryLevels(levels)
  const topics = pluralize(levels.length, 'topic')
  if (counts.strong > 0) return `${topics}, ${counts.strong} strong`
  if (counts.getting > 0) return `${topics}, ${counts.getting} getting there`
  if (counts.learning > 0) return `${topics}, ${counts.learning} learning`
  return topics
}

/**
 * The colour legend explains what the squares mean. While every topic is "Not started" all squares are
 * the same grey and there is nothing to explain, so the legend waits for the first coloured one.
 */
export const hasMasteryColours = (levelsPerCourse: MasteryLevel[][]): boolean =>
  levelsPerCourse.some((levels) => levels.some((level) => level !== 'none'))
