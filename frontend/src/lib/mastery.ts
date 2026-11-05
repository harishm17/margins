/**
 * How a mastery value (0..1, from ReviewSchedule.mastery) is named and shown.
 * No row (null or undefined) means no signal yet: "Not started".
 */

import { TOPIC_PROGRESS_WORDS } from './learning/progress-words'

export type MasteryLevel = 'none' | 'learning' | 'getting' | 'strong'

// The words are the glossary's (lib/learning/progress-words.ts): the only place a topic band is named.
export const MASTERY_LABELS: Record<MasteryLevel, string> = TOPIC_PROGRESS_WORDS

export const LEARNING_BELOW = 0.4
export const STRONG_FROM = 0.8

export function masteryLevel(mastery: number | null | undefined): MasteryLevel {
  if (mastery === null || mastery === undefined || Number.isNaN(mastery)) return 'none'
  if (mastery < LEARNING_BELOW) return 'learning'
  if (mastery < STRONG_FROM) return 'getting'
  return 'strong'
}

export const masteryLabel = (mastery: number | null | undefined): string =>
  MASTERY_LABELS[masteryLevel(mastery)]

/** Whole percent, rounded down so it never reads as the next level up (79.6 stays 79). */
export function masteryPercent(mastery: number | null | undefined): number | null {
  if (mastery === null || mastery === undefined || Number.isNaN(mastery)) return null
  return Math.min(100, Math.max(0, Math.floor(mastery * 100 + 1e-9)))
}

/** "Getting there, 62%" or "Not started". */
export function masteryDescription(mastery: number | null | undefined): string {
  const percent = masteryPercent(mastery)
  return percent === null ? MASTERY_LABELS.none : `${masteryLabel(mastery)}, ${percent}%`
}

/** Learning is the one level shown in the warning colour; the rest use the accent. */
export const masteryTone = (level: MasteryLevel): 'neutral' | 'warning' | 'accent' =>
  level === 'learning' ? 'warning' : level === 'none' ? 'neutral' : 'accent'

/**
 * Course mastery: the mean mastery over every topic, with topics that have no signal yet counted
 * as 0, so a course with one of seven topics started does not read as most of the way done.
 * Null only when the course has no topics.
 */
export function courseMastery(masteries: (number | null | undefined)[]): number | null {
  if (masteries.length === 0) return null
  const total = masteries.reduce<number>(
    (sum, value) => sum + (value === null || value === undefined || Number.isNaN(value) ? 0 : value),
    0
  )
  return total / masteries.length
}

export type MasteryCounts = Record<MasteryLevel, number>

export function countMasteryLevels(levels: MasteryLevel[]): MasteryCounts {
  const counts: MasteryCounts = { none: 0, learning: 0, getting: 0, strong: 0 }
  for (const level of levels) counts[level] += 1
  return counts
}
