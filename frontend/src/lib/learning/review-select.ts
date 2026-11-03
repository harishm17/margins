/**
 * Selecting review items (spec §7.4). Pure functions: which due concepts to serve and in what order,
 * which bank item for each, how a session opens, and which fresh-form retests close it.
 */

import type { MissKind } from '../tutor/state'
import { conceptBand, type BandInputs } from './level'
import { advanceMode, withoutDiscrimination, type Mode } from './memory'
import type { Rung } from './practice-evidence'
import { localDateParts } from './study-plan-time'

export type { Mode }

export type Difficulty = 'easy' | 'medium' | 'hard'

export type DueConcept = {
  conceptId: string
  topicId: string
  misconception: boolean
  dueAt: Date
  retrievability: number
  mastery: number
  lastMaxRung: Rung | null
  /** What `conceptBand` reads: the one place a support level is decided (spec 18.6). */
  bandInputs: BandInputs
  modeReached: Mode
  lastMissKind?: MissKind
  confusableId?: string
}

export type BankItem = {
  itemKey: string
  conceptIds: string[]
  difficulty: Difficulty
  mode: Mode
  topicId: string
  lastAnsweredAt: Date | null
}

/** Concepts that need a new item generated, one entry per topic, mode and difficulty. */
export type MissingItems = { topicId: string; conceptIds: string[]; mode: Mode; difficulty: Difficulty }

export type AnsweredItem = {
  itemKey: string
  conceptIds: string[]
  correct: boolean
  maxRung: Rung
  surrendered: boolean
  topicId: string
  /** The answered item's mode and difficulty, so a missing retest can be generated alike. */
  mode?: Mode
  difficulty?: Difficulty
}

const DAY_MS = 24 * 60 * 60 * 1000
const UNSEEN_DAYS = 7
const MAX_TOPIC_RUN = 3
const BANDS: Difficulty[] = ['easy', 'medium', 'hard']
const OPENING_SIZE = 2

const MISS_KINDS = ['cue_miss', 'discrimination', 'execution', 'careless', 'misconception'] as const satisfies readonly MissKind[]

/** Narrows the stored `lastMissKind` string to a known miss kind; anything else is undefined. */
export function toMissKind(value: string | null | undefined): MissKind | undefined {
  return (MISS_KINDS as readonly string[]).includes(value ?? '') ? (value as MissKind) : undefined
}

/** Narrows the stored `lastMaxRung` number to a rung 0 to 5; anything else is null. */
export function toRung(value: number | null | undefined): Rung | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
    ? (value as Rung)
    : null
}

/**
 * The mode served next. The transition is memory.ts's, which the replay uses too; a miss kind then forces
 * its mode (spec §7.4): `cue_miss` recall, `discrimination` discrimination. `hasConfusable` is false
 * when the concept has no near-twin, so discrimination is skipped.
 */
export function nextMode(
  modeReached: Mode,
  lastOutcome: { mode: Mode; correct: boolean; missKind?: MissKind },
  hasConfusable = true
): Mode {
  const forced = lastOutcome.correct ? null : forcedMode(lastOutcome.missKind, hasConfusable)
  return forced ?? advanceMode(modeReached, lastOutcome, hasConfusable)
}

function forcedMode(missKind: MissKind | undefined, hasConfusable: boolean): Mode | null {
  if (missKind === 'cue_miss') return 'recall'
  if (missKind === 'discrimination' && hasConfusable) return 'discrimination'
  return null
}

// The stored modeReached is already the mode after the last answer, so only the last miss kind is left to apply.
function modeToServe(concept: DueConcept): Mode {
  const hasConfusable = !!concept.confusableId
  const forced = forcedMode(concept.lastMissKind, hasConfusable)
  if (forced) return forced
  if (hasConfusable) return concept.modeReached
  return withoutDiscrimination(concept.modeReached, !concept.lastMissKind)
}

/** The difficulty band a concept's next item aims at: the concept's support band (`conceptBand`, spec 18.6). */
export function targetDifficulty(concept: DueConcept): Difficulty {
  return BANDS[targetBand(concept)]
}

function targetBand(concept: DueConcept): number {
  return conceptBand(concept.bandInputs)
}

function localDay(at: Date, timeZone: string): number {
  const { year, month, day } = localDateParts(at, timeZone)
  return year * 10000 + month * 100 + day
}

function answeredToday(item: BankItem, now: Date, timeZone: string): boolean {
  return item.lastAnsweredAt !== null && localDay(item.lastAnsweredAt, timeZone) === localDay(now, timeZone)
}

function unseen(item: BankItem, now: Date): boolean {
  return item.lastAnsweredAt === null || now.getTime() - item.lastAnsweredAt.getTime() >= UNSEEN_DAYS * DAY_MS
}

function lastAnsweredMs(item: BankItem): number {
  return item.lastAnsweredAt ? item.lastAnsweredAt.getTime() : -Infinity
}

// Misconception first, then the most overdue (by the student's local day, so R breaks ties within a day),
// then the lowest retrievability.
export function byPriority(timeZone: string) {
  return (a: DueConcept, b: DueConcept): number => {
    if (a.misconception !== b.misconception) return a.misconception ? -1 : 1
    const dayA = localDay(a.dueAt, timeZone)
    const dayB = localDay(b.dueAt, timeZone)
    if (dayA !== dayB) return dayA < dayB ? -1 : 1
    return a.retrievability - b.retrievability
  }
}

// Best first: not redundant with what is already covered, unseen for 7 days, nearest the target band,
// then the longest since answered.
function rankCandidates(concept: DueConcept, candidates: BankItem[], now: Date, covered: Set<string>): BankItem[] {
  const band = targetBand(concept)
  const key = (item: BankItem) => [
    item.conceptIds.some((c) => covered.has(c)) ? 1 : 0,
    unseen(item, now) ? 0 : 1,
    Math.abs(BANDS.indexOf(item.difficulty) - band),
    lastAnsweredMs(item),
  ]
  return [...candidates].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    const at = ka.findIndex((v, i) => v !== kb[i])
    return at >= 0 ? ka[at] - kb[at] : a.itemKey < b.itemKey ? -1 : 1
  })
}

function overlaps(a: BankItem, b: BankItem): boolean {
  return a.conceptIds.some((c) => b.conceptIds.includes(c))
}

function topicRun(placed: BankItem[]): number {
  let run = 0
  for (let i = placed.length - 1; i >= 0 && placed[i].topicId === placed[placed.length - 1].topicId; i--) run++
  return run
}

// Whether `item` may follow the last placed item: never on the same concept, and (unless the topic rule is
// lifted) not as a fourth in a row from one topic.
function mayFollow(placed: BankItem[], item: BankItem, liftTopicRule: boolean): boolean {
  const last = placed[placed.length - 1]
  if (!last) return true
  if (overlaps(item, last)) return false
  return liftTopicRule || item.topicId !== last.topicId || topicRun(placed) < MAX_TOPIC_RUN
}

/**
 * Orders `items` after `previous` (already placed) so that no two neighbours share a concept and no more
 * than three in a row share a topic. Greedy with no backtracking: each position takes the first item, in
 * the order given, that keeps both rules, falling back to the next best. The topic rule is lifted only
 * when nothing else fits (a session of one topic), so it still fills; the concept rule is never lifted.
 * Items left when nothing fits are returned as `deferred`; they are never squeezed in out of order, and
 * the caller keeps them for a later session.
 */
function interleave(items: BankItem[], previous: BankItem[] = []): { placed: BankItem[]; deferred: BankItem[] } {
  const placed = [...previous]
  const rest = [...items]
  while (rest.length > 0) {
    let at = rest.findIndex((item) => mayFollow(placed, item, false))
    if (at < 0) at = rest.findIndex((item) => mayFollow(placed, item, true))
    if (at < 0) break
    placed.push(rest.splice(at, 1)[0])
  }
  return { placed: placed.slice(previous.length), deferred: rest }
}

/**
 * Places `items` after the items a session already serves, by the same adjacency rules as the session
 * itself: never two in a row on one concept, at most three in a row on one topic. Items that fit nowhere
 * come back as `deferred`.
 */
export function appendInterleaved(
  served: BankItem[],
  items: BankItem[],
  max: number
): { placed: BankItem[]; deferred: BankItem[] } {
  const room = Math.max(0, max - served.length)
  const { placed, deferred } = interleave(items, served)
  return { placed: placed.slice(0, room), deferred: [...placed.slice(room), ...deferred] }
}

type Slot = { concept: DueConcept; candidates: BankItem[] }

export function selectReviewItems(input: {
  due: DueConcept[]
  bank: BankItem[]
  now: Date
  max: number
  /** The student's IANA zone: decides which items were answered "today" and which due day is older. */
  timeZone: string
}): { items: BankItem[]; missing: MissingItems[]; deferred: BankItem[] } {
  const { bank, now, max, timeZone } = input
  const missingByGroup = new Map<string, MissingItems>()
  const addMissing = (topicId: string, mode: Mode, difficulty: Difficulty, conceptId: string) => {
    const groupKey = `${topicId}\u0000${mode}\u0000${difficulty}`
    const group = missingByGroup.get(groupKey) ?? { topicId, conceptIds: [], mode, difficulty }
    if (!group.conceptIds.includes(conceptId)) group.conceptIds.push(conceptId)
    missingByGroup.set(groupKey, group)
  }
  // An item answered on the same local day is never served again, whatever else the bank holds.
  const servable = bank.filter((item) => !answeredToday(item, now, timeZone))

  const slots: Slot[] = []
  const handled: { concept: DueConcept; mode: Mode }[] = []
  let used = 0
  for (const concept of [...input.due].sort(byPriority(timeZone))) {
    if (used >= max) break
    const mode = modeToServe(concept)
    const candidates = servable.filter((item) => item.mode === mode && item.conceptIds.includes(concept.conceptId))
    used += 1
    handled.push({ concept, mode })
    if (candidates.length > 0) slots.push({ concept, candidates })
    else addMissing(concept.topicId, mode, BANDS[targetBand(concept)], concept.conceptId)
  }

  // Open warm: the weakest concepts need an easy item to start on; ask for one where there is none.
  for (const { concept, mode } of [...handled].sort((a, b) => a.concept.mastery - b.concept.mastery).slice(0, OPENING_SIZE)) {
    const hasEasy = servable.some(
      (item) => item.difficulty === 'easy' && item.mode === mode && item.conceptIds.includes(concept.conceptId)
    )
    if (!hasEasy) addMissing(concept.topicId, mode, 'easy', concept.conceptId)
  }

  // Place one item per slot in priority order. For each position the first slot with any candidate that
  // follows the adjacency rules wins; its next-best candidates are tried before the slot is deferred.
  const placed: BankItem[] = []
  const covered = new Set<string>()
  const remaining = [...slots]
  const tryPlace = (liftTopicRule: boolean): { slot: number; item: BankItem } | null => {
    for (let s = 0; s < remaining.length; s++) {
      const ranked = rankCandidates(remaining[s].concept, remaining[s].candidates, now, covered)
      const item = ranked.find(
        (c) => !placed.some((p) => p.itemKey === c.itemKey) && mayFollow(placed, c, liftTopicRule)
      )
      if (item) return { slot: s, item }
    }
    return null
  }
  while (placed.length < max && remaining.length > 0) {
    const hit = tryPlace(false) ?? tryPlace(true)
    if (!hit) break
    placed.push(hit.item)
    for (const id of hit.item.conceptIds) covered.add(id)
    for (let s = remaining.length - 1; s >= 0; s--)
      if (covered.has(remaining[s].concept.conceptId)) remaining.splice(s, 1)
  }

  // Slots still waiting when nothing fit (not when the cap was reached) are deferred with their best item.
  const deferred: BankItem[] = []
  if (placed.length < max) {
    for (const slot of remaining) {
      const best = rankCandidates(slot.concept, slot.candidates, now, covered).find(
        (c) => !placed.some((p) => p.itemKey === c.itemKey) && !deferred.some((d) => d.itemKey === c.itemKey)
      )
      if (best) deferred.push(best)
    }
  }
  return { items: placed, missing: [...missingByGroup.values()], deferred }
}

/**
 * The opening is one or two easy items on the weakest concepts, to bring the cluster back to mind
 * (spec §7.4). `mastery` maps concept id to mastery; without it, the order given stands. The body is
 * placed after the opening with the same rules, so the join holds. Items that cannot be placed come back
 * as `deferred`, never appended out of order.
 */
export function sessionShape(
  items: BankItem[],
  mastery: Record<string, number> = {}
): { opening: BankItem[]; body: BankItem[]; deferred: BankItem[] } {
  const weakness = (item: BankItem) => Math.min(...item.conceptIds.map((c) => mastery[c] ?? 1))
  const easy = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.difficulty === 'easy')
    .sort((a, b) => weakness(a.item) - weakness(b.item) || a.index - b.index)
    .slice(0, OPENING_SIZE)
    .map(({ item }) => item)
  const { placed: opening } = interleave(easy)
  const { placed: body, deferred } = interleave(
    items.filter((item) => !opening.includes(item)),
    opening
  )
  return { opening, body, deferred }
}

/**
 * One fresh item per concept that missed, needed rung 2 or more, or was surrendered. Answers are merged
 * by item key first (a surrender and its later finish event share one), and a merged item needs a retest
 * if any of its events does. Nothing the session already served is reused, nor anything answered on the
 * same local day when `today` is given. Concepts with no fresh item come back in `missing`.
 */
export function closingRetests(
  answered: AnsweredItem[],
  bank: BankItem[],
  today?: { now: Date; timeZone: string }
): { items: BankItem[]; missing: MissingItems[] } {
  const merged = new Map<string, AnsweredItem>()
  for (const a of answered) {
    const m = merged.get(a.itemKey)
    if (!m) {
      merged.set(a.itemKey, { ...a, conceptIds: [...a.conceptIds] })
      continue
    }
    m.correct = m.correct && a.correct
    m.surrendered = m.surrendered || a.surrendered
    m.maxRung = Math.max(m.maxRung, a.maxRung) as Rung
    for (const id of a.conceptIds) if (!m.conceptIds.includes(id)) m.conceptIds.push(id)
  }

  const needing = new Map<string, AnsweredItem>()
  for (const a of merged.values()) {
    if (a.correct && a.maxRung < 2 && !a.surrendered) continue
    for (const id of a.conceptIds) if (!needing.has(id)) needing.set(id, a)
  }

  const needCount = (item: BankItem) => item.conceptIds.filter((c) => needing.has(c)).length
  const items: BankItem[] = []
  const covered = new Set<string>()
  const missingByGroup = new Map<string, MissingItems>()
  for (const [conceptId, from] of needing) {
    if (covered.has(conceptId)) continue
    const fresh = bank
      .filter(
        (item) =>
          item.conceptIds.includes(conceptId) &&
          !merged.has(item.itemKey) &&
          !items.some((o) => o.itemKey === item.itemKey) &&
          !(today && answeredToday(item, today.now, today.timeZone))
      )
      .sort(
        (a, b) =>
          needCount(b) - needCount(a) ||
          lastAnsweredMs(a) - lastAnsweredMs(b) ||
          (a.itemKey < b.itemKey ? -1 : 1)
      )[0]
    if (!fresh) {
      const mode = from.mode ?? 'recall'
      const difficulty = from.difficulty ?? 'medium'
      const groupKey = `${from.topicId}\u0000${mode}\u0000${difficulty}`
      const group = missingByGroup.get(groupKey) ?? { topicId: from.topicId, conceptIds: [], mode, difficulty }
      group.conceptIds.push(conceptId)
      missingByGroup.set(groupKey, group)
      continue
    }
    items.push(fresh)
    for (const id of fresh.conceptIds) covered.add(id)
  }
  return { items, missing: [...missingByGroup.values()] }
}
