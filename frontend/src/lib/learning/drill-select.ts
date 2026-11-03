/**
 * Choosing the items of a concept drill (spec §7.4, §8.1): 3 to 5 items on one concept, and one item on
 * its weakest prerequisite when that prerequisite's retrievability is under 0.8. A drill that follows a
 * live misconception pairs the concept with its near-twin, so it leads with discrimination. Pure; the
 * database reads and the session are in review-session.ts.
 */

import {
  targetDifficulty,
  type BankItem,
  type Difficulty,
  type DueConcept,
  type MissingItems,
  type Mode,
} from './review-select'
import { localDateParts } from './study-plan-time'

/** Items on the drilled concept itself; the prerequisite's item is on top of these. */
export const DRILL_SIZE = 4
/** A prerequisite below this retrievability is worth an item before the drill proper (same line as the practice tutor's). */
export const WEAK_PREREQUISITE_R = 0.8

const BANDS: Difficulty[] = ['easy', 'medium', 'hard']
const UNSEEN_MS = 7 * 24 * 60 * 60 * 1000

/** The prerequisite with the lowest retrievability under the line; null when none is below it. */
export function pickWeakestPrerequisite<T extends { retrievability: number }>(candidates: T[]): T | null {
  const weak = candidates.filter((candidate) => candidate.retrievability < WEAK_PREREQUISITE_R)
  if (weak.length === 0) return null
  return weak.reduce((worst, candidate) => (candidate.retrievability < worst.retrievability ? candidate : worst))
}

// The modes the drill walks through. A near-twin gives discrimination its place; after a mix-up (a live
// misconception, or a discrimination miss) the drill starts there.
function modeSequence(concept: DueConcept): Mode[] {
  if (!concept.confusableId) return ['recall', 'recall', 'composition', 'composition']
  const mixedUp = concept.misconception || concept.lastMissKind === 'discrimination'
  return mixedUp ? ['discrimination', 'recall', 'discrimination', 'composition'] : ['recall', 'discrimination', 'composition', 'discrimination']
}

// The drill ramps: the first two items at the concept's band, the rest one band up.
function difficultyAt(concept: DueConcept, position: number): Difficulty {
  const band = BANDS.indexOf(targetDifficulty(concept))
  return BANDS[Math.min(2, band + (position >= 2 ? 1 : 0))]
}

function localDay(at: Date, timeZone: string): number {
  const { year, month, day } = localDateParts(at, timeZone)
  return year * 10000 + month * 100 + day
}

export function selectDrillItems(input: {
  concept: DueConcept
  /** The weakest prerequisite below the line, from `pickWeakestPrerequisite`; null for none. */
  prerequisite: DueConcept | null
  bank: BankItem[]
  /** Items the session already serves: not served again, and they fill the first slots. */
  served: BankItem[]
  now: Date
  timeZone: string
  size?: number
}): { items: BankItem[]; missing: MissingItems[] } {
  const { concept, prerequisite, bank, served, now, timeZone } = input
  const size = Math.min(5, Math.max(3, input.size ?? DRILL_SIZE))
  const todayKey = localDay(now, timeZone)
  const taken = new Set(served.map((item) => item.itemKey))
  const servable = bank.filter(
    (item) =>
      !taken.has(item.itemKey) && !(item.lastAnsweredAt !== null && localDay(item.lastAnsweredAt, timeZone) === todayKey)
  )

  const missingByGroup = new Map<string, MissingItems>()
  const addMissing = (c: DueConcept, mode: Mode, difficulty: Difficulty) => {
    const groupKey = `${c.topicId}\u0000${mode}\u0000${difficulty}`
    const group = missingByGroup.get(groupKey) ?? { topicId: c.topicId, conceptIds: [], mode, difficulty }
    if (!group.conceptIds.includes(c.conceptId)) group.conceptIds.push(c.conceptId)
    missingByGroup.set(groupKey, group)
  }

  // Best first: nearest the wanted difficulty, unseen for a week, then the longest since answered.
  const pick = (c: DueConcept, mode: Mode, difficulty: Difficulty, used: Set<string>): BankItem | null => {
    const wanted = BANDS.indexOf(difficulty)
    const candidates = servable
      .filter((item) => !used.has(item.itemKey) && item.mode === mode && item.conceptIds.includes(c.conceptId))
      .sort((a, b) => {
        const unseen = (item: BankItem) => (item.lastAnsweredAt === null || now.getTime() - item.lastAnsweredAt.getTime() >= UNSEEN_MS ? 0 : 1)
        const last = (item: BankItem) => (item.lastAnsweredAt ? item.lastAnsweredAt.getTime() : -Infinity)
        return (
          unseen(a) - unseen(b) ||
          Math.abs(BANDS.indexOf(a.difficulty) - wanted) - Math.abs(BANDS.indexOf(b.difficulty) - wanted) ||
          last(a) - last(b) ||
          (a.itemKey < b.itemKey ? -1 : 1)
        )
      })
    return candidates[0] ?? null
  }

  const used = new Set<string>()
  const items: BankItem[] = []

  if (prerequisite && !served.some((item) => item.conceptIds.includes(prerequisite.conceptId))) {
    const difficulty = targetDifficulty(prerequisite)
    const found = pick(prerequisite, 'recall', difficulty, used)
    if (found) {
      used.add(found.itemKey)
      items.push(found)
    } else {
      addMissing(prerequisite, 'recall', difficulty)
    }
  }

  const sequence = modeSequence(concept).slice(0, size)
  const already = served.filter((item) => item.conceptIds.includes(concept.conceptId)).length
  sequence.forEach((mode, position) => {
    if (position < already) return
    const difficulty = difficultyAt(concept, position)
    const found = pick(concept, mode, difficulty, used)
    if (found) {
      used.add(found.itemKey)
      items.push(found)
    } else {
      addMissing(concept, mode, difficulty)
    }
  })
  return { items, missing: [...missingByGroup.values()] }
}
