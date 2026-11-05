import { pluralize } from '@/lib/format'
import { countMasteryLevels, MASTERY_LABELS, type MasteryLevel } from '@/lib/mastery'

/**
 * The status line on an active course card, as one count in the glossary's topic words (lib/learning/progress-words.ts):
 * the most advanced level that has any topics in it, out of all of them: "2 of 4 topics strong", else "1 of 3 topics
 * getting there", else "1 of 3 topics learning". A level with no topics is never named, so there is no "0 of 4 strong";
 * nothing started says only "4 topics".
 */
export function activeStatusLine(levels: MasteryLevel[]): string {
  const counts = countMasteryLevels(levels)
  const topics = pluralize(levels.length, 'topic')
  const named = (['strong', 'getting', 'learning'] as const).find((level) => counts[level] > 0)
  if (!named) return topics
  return `${counts[named]} of ${topics} ${MASTERY_LABELS[named].toLowerCase()}`
}
