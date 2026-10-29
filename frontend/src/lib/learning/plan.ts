import { intervalFromMastery } from './mastery-math'
import { localDateParts } from './study-plan-time'

/**
 * The study plan: a deterministic, pure computation (no database, no model, no clock of its own).
 * It lays the work that is left out over the days from today to the exam date, or over a rolling
 * 14 days when there is no exam date. It is recomputed from the student's state on every load, so
 * "done" always comes from real progress and the plan never drifts from what happened.
 *
 * The daily minutes are a hard cap: no day holds more than that, today's finished work included. The
 * one exception is a full mock exam longer than the whole day: it sits alone on its day, marked
 * `overBudget`, and the page says it is longer than the usual time.
 *
 * What goes where, in the order it is placed on each day:
 *   - Full mock exams: two before the exam, the second at least 2 days before it. The first goes the
 *     day after the last first quiz when 7 or more days are left then (a first look at what is still
 *     weak), else 5 days before the exam.
 *   - Reviews at the review schedule's due day (overdue ones today) and the first quiz the day after
 *     a topic is learned. These come before new learning; whatever does not fit moves to the next day.
 *   - A unit mock exam after each unit that is fully learned (units with 3 or more topics): on the
 *     first day after its topics' first quizzes (that day included) with room for it, one a day.
 *   - Spaced reviews beyond the ones already scheduled: after a topic's first quiz (and after each
 *     review) the next review is projected forward on the app's own interval ladder (1, 3, 7, 14
 *     days, starting from the rung its mastery earns, or 0.6 when it has not been quizzed), up to the
 *     last day before the final review days that has room, so a learned topic is reviewed before the
 *     exam. A last review that would crowd that day is booked on an earlier day with room instead.
 *     A real due date wins over a projection. Projected reviews are `projected: true`.
 *   - Learn blocks, in course order but never before a prerequisite, each `estimatedMinutes` long
 *     (35 when unknown), packed into the daily minutes. A topic that does not fit what is left of a
 *     day is split: a part today and the rest the next day, every part at least 15 minutes.
 *   - Once everything is learned and an exam date is set, free time goes to "Mixed practice": a mock
 *     exam on 2-3 topics, weighted to the weakest and those on past exams, up to the daily minutes,
 *     never the same topics twice on one day, with the 7th day of each run left free to rest.
 *   - The last 2 days (the day before the exam and the exam day) hold only reviews of the weakest topics.
 *
 * When the exam is too close for everything to fit, the plan says so and chooses: the optional unit
 * mock exams are dropped, then the earlier of the two full mock exams (one stays, 2 or more days before
 * the exam), then topics that appear on past exams come first, then course order. Topics
 * that still do not fit are listed as not scheduled; nothing is dropped silently.
 *
 * A topic longer than the daily minutes that cannot be split into parts that each fit a day (every part
 * at least 15 minutes, the last at least 10) is never scheduled, however many days there are. It, and what needs it first, is
 * listed apart (tooLongForDay) and does not hold up the topics after it or count as time being short.
 * A review that finds no day with room before the exam goes to the final review days if it can, then to
 * the latest earlier day with room, and is otherwise listed (reviewsNotScheduled) with the real reason:
 * no room in the minutes, or the limit on reviews in the last two days.
 */

export const DEFAULT_TOPIC_MINUTES = 35
export const REVIEW_MINUTES = 10
export const QUIZ_MINUTES = 15
export const UNIT_MOCK_MINUTES = 30
export const FULL_MOCK_MINUTES = 60
/** A topic is only split across days into parts of at least this long... */
export const MIN_PART_MINUTES = 15
/**
 * ...except the last part, which may be shorter when that is the only way to finish the topic: a topic
 * with 25 minutes left on a 20-minute day (a 45 or 50-minute topic once started) could not be finished
 * at all, though the whole topic can (15 + 15 + 15). The split prefers a last part of 15, then 10 (25 is
 * 15 + 10), and only then this, the shortest part ever planned (20 left on a 17-minute day is 15 + 5).
 */
export const MIN_FINAL_PART_MINUTES = 5
const PREFERRED_FINAL_PART_MINUTES = 10
/** Reviews on the last two days: at most this many the day before the exam, and this many on the exam day. */
export const FINAL_DAY_REVIEWS = 5
export const EXAM_DAY_REVIEWS = 2
export const ROLLING_DAYS = 14
/** The longest stretch laid out, however far away the exam is. */
export const MAX_PLAN_DAYS = 120
export const MIN_DAILY_MINUTES = 10
export const MAX_DAILY_MINUTES = 600
export const UNIT_MOCK_MIN_TOPICS = 3
/** The first full mock goes the day after the last first quiz when at least this many days remain. */
export const EARLY_MOCK_DAYS = 7
export const MIXED_MIN_MINUTES = 15
export const MIXED_MAX_MINUTES = 30
export const MIXED_MAX_PER_DAY = 3
/** Topics in one mixed practice set (at least 2: one topic is a review, not mixed practice). */
export const MIXED_SET_SIZE = 3
/** One rest day in every run of this many days once learning is done. */
export const REST_EVERY = 7
/** The review intervals, in days, from the app's own ladder (see intervalFromMastery). */
export const REVIEW_LADDER = [1, 3, 7, 14] as const
/** Mastery assumed for a topic that has not been quizzed yet. */
export const ASSUMED_MASTERY = 0.6

export type PlanTopic = {
  id: string
  name: string
  unitId: string | null
  orderIndex: number
  /** Topics (same course) to learn first. */
  prerequisiteIds: string[]
  estimatedMinutes: number | null
  /** The topic's concepts appear on the student's past exams. */
  examRelevant: boolean
  /** Notes and worked examples are both finished. */
  learned: boolean
  /** One of them is finished. */
  started: boolean
  /** The quiz has been taken at least once. */
  quizzed: boolean
  /** Displayed mastery (0..1) or null with no signal yet. */
  mastery: number | null
  /** When the next review is due, from the review schedule. */
  reviewDueAt: Date | null
  /** The topic's learning was finished today (it is quizzed tomorrow, not today). */
  learnedToday: boolean
}

export type PlanUnit = { id: string; title: string; weekLabel: string | null; orderIndex: number }

/** Something finished today, shown ticked on today's list and taking its time out of today. */
export type DoneToday =
  | { kind: 'learn' | 'quiz' | 'review'; topicId: string }
  /** A mock exam submitted today, with the minutes it took (see mockMinutesSpent in server/queries/plan.ts). */
  | { kind: 'mock'; examId: string; name: string; minutes: number }

export type PlanInput = {
  now: Date
  /** The student's IANA time zone: days are their days. */
  timeZone: string
  /** The exam date as YYYY-MM-DD (a calendar date), or null for a rolling two weeks. */
  examDate: string | null
  dailyMinutes: number
  /** The confirmed topics of the course. */
  topics: PlanTopic[]
  units: PlanUnit[]
  /** Units whose topics a mock exam already covered, so no unit mock is planned. */
  unitMocksDone: string[]
  /** Full mock exams already taken in the final week (the 7 days up to the exam), today's included. */
  fullMocksDoneInFinalWeek: number
  doneToday: DoneToday[]
}

export type PlanItemKind = 'learn' | 'quiz' | 'review' | 'mixed' | 'unit_mock' | 'full_mock'

export type PlanItem = {
  id: string
  kind: PlanItemKind
  /** YYYY-MM-DD. */
  date: string
  title: string
  topicId: string | null
  unitId: string | null
  /** The topics a mock exam covers. */
  topicIds: string[]
  minutes: number
  done: boolean
  /** A learn block split across days: "part 1 of 2". */
  part: { number: number; of: number } | null
  /** A short qualifier: "Overdue", "Weakest topic", "On past exams". */
  note: string | null
  /** A review projected on the interval ladder (no review date is stored for it yet). */
  projected: boolean
  /** The topic's mastery (0..1) when the plan was made, for reviews: it lets the copy say something specific. */
  mastery?: number | null
  /** A full mock exam longer than the time its day has: it is alone on the day (the one exception to the cap). */
  overBudget?: boolean
}

export type PlanDay = {
  /** YYYY-MM-DD. */
  date: string
  isToday: boolean
  isExamDay: boolean
  /** The last 2 days before the exam, which hold reviews of the weakest topics only. */
  isFinalReview: boolean
  items: PlanItem[]
  /** Minutes of work still to do, and minutes already done today. */
  minutes: number
  doneMinutes: number
}

export type PlanStatus = 'ready' | 'no_topics' | 'exam_passed'

export type Plan = {
  status: PlanStatus
  /** Today's date in the student's time zone, YYYY-MM-DD. */
  today: string
  mode: 'exam' | 'rolling'
  examDate: string | null
  /** Whole days from today to the exam (0 on the exam day), or null without a date. */
  daysToExam: number | null
  dailyMinutes: number
  days: PlanDay[]
  /** The exam is too close to learn everything. */
  short: boolean
  /** Plain words for the short-time warning, or null. */
  shortMessage: string | null
  /** The optional unit mock exams were left out to make room for topics. */
  unitMocksSkipped: boolean
  /** Only one of the two full mock exams is planned, to leave time for learning. */
  fullMocksReduced: boolean
  /** Topics that are not in the plan for lack of days, with why. Null when everything is scheduled. */
  notScheduled: { reason: 'short' | 'later'; topics: { id: string; name: string }[] } | null
  /**
   * Topics longer than the daily minutes that cannot be split into parts of at least MIN_PART_MINUTES
   * that fit a day (so no number of days helps), and the topics that need one of them first. Null when none.
   */
  tooLongForDay: { topics: { id: string; name: string }[]; dependents: { id: string; name: string }[] } | null
  /**
   * Learned topics whose review before the exam found no day with room (exam plans only), with why: the
   * minutes of every day are used (more study time helps), or the last two days hold only so many reviews
   * and no earlier day exists (it does not). Null when none.
   */
  reviewsNotScheduled: { id: string; name: string; reason: ReviewLossReason }[] | null
  /** Why fewer than two full mock exams were planned, or null. */
  mockNote: string | null
  /** Learning left: topics and minutes (before scheduling). */
  remaining: { topics: number; minutes: number }
}

// ---------------------------------------------------------------------------------------
// Days

const DAY_MS = 24 * 60 * 60 * 1000
const pad = (value: number) => String(value).padStart(2, '0')

const dayToUtc = (day: string): number => {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}
const utcToDay = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** The calendar date it is at `instant` in `timeZone`, as YYYY-MM-DD. */
export function localDay(instant: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(instant, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

export const addDays = (day: string, count: number): string => utcToDay(dayToUtc(day) + count * DAY_MS)

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((dayToUtc(to) - dayToUtc(from)) / DAY_MS)

/** The Monday of the week a day is in. */
export function weekStart(day: string): string {
  const weekday = new Date(dayToUtc(day)).getUTCDay() // 0 is Sunday
  return addDays(day, -((weekday + 6) % 7))
}

export const isDayString = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return utcToDay(dayToUtc(value)) === value
}

// ---------------------------------------------------------------------------------------
// Building blocks

const clampMinutes = (value: number) =>
  Math.min(MAX_DAILY_MINUTES, Math.max(MIN_DAILY_MINUTES, Math.round(Number.isFinite(value) ? value : 45)))

const roundUp5 = (minutes: number) => Math.max(10, Math.ceil(minutes / 5) * 5)

/**
 * Whether `minutes` of learning can be finished on days of `daily` minutes: whole on one day, or split
 * into parts that each fit a day, every part at least MIN_PART_MINUTES except the last, which may be as
 * short as `minLast` (MIN_FINAL_PART_MINUTES unless a stricter split is asked for). A topic that cannot
 * is never scheduled (see Plan.tooLongForDay): that only happens when a day is shorter than a part, so
 * more study time fixes it, and starting a topic never makes it happen.
 */
export function fitsInDays(minutes: number, daily: number, options: { minLast?: number } = {}): boolean {
  if (minutes <= daily) return true
  if (daily < MIN_PART_MINUTES) return false
  const last = options.minLast ?? MIN_FINAL_PART_MINUTES
  // k parts fit when (k - 1) * MIN_PART_MINUTES + last <= minutes <= k * daily.
  for (let parts = 2; (parts - 1) * MIN_PART_MINUTES + last <= minutes; parts += 1) if (minutes <= parts * daily) return true
  return false
}

/** Minutes of learning a topic still needs: all of it, half when one of notes and examples is done, none when learned. */
export function learnMinutesLeft(topic: Pick<PlanTopic, 'estimatedMinutes' | 'learned' | 'started'>): number {
  if (topic.learned) return 0
  const total = topic.estimatedMinutes && topic.estimatedMinutes > 0 ? topic.estimatedMinutes : DEFAULT_TOPIC_MINUTES
  return topic.started ? roundUp5(total / 2) : roundUp5(total)
}

/**
 * The order to learn topics in. Course order, except that a topic never comes before an unlearned
 * prerequisite. With `examFirst`, topics on past exams (and what they need first) come before the
 * rest, each group in course order.
 */
export function learnOrder(topics: PlanTopic[], options: { examFirst: boolean }): PlanTopic[] {
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const todo = topics.filter((topic) => !topic.learned).sort((a, b) => a.orderIndex - b.orderIndex)
  const todoIds = new Set(todo.map((topic) => topic.id))
  const rank = (topic: PlanTopic) => (options.examFirst && topic.examRelevant ? 0 : 1)
  const candidates = [...todo].sort((a, b) => rank(a) - rank(b) || a.orderIndex - b.orderIndex)

  const placed = new Set<string>()
  const ordered: PlanTopic[] = []
  // Each topic brings the unlearned prerequisites it needs in front of it (in course order). A
  // cycle, which the course planner never writes, is cut where it closes.
  const place = (topic: PlanTopic, path: Set<string>) => {
    if (placed.has(topic.id) || path.has(topic.id)) return
    path.add(topic.id)
    const needs = topic.prerequisiteIds
      .filter((id) => id !== topic.id && todoIds.has(id))
      .map((id) => byId.get(id) as PlanTopic)
      .sort((a, b) => a.orderIndex - b.orderIndex)
    for (const need of needs) place(need, path)
    path.delete(topic.id)
    placed.add(topic.id)
    ordered.push(topic)
  }
  for (const topic of candidates) place(topic, new Set())
  return ordered
}

type Spaced = {
  kind: 'quiz' | 'review'
  topic: PlanTopic
  /** Day index it is due; later days pick up what did not fit. */
  target: number
  note: string | null
  /** The ladder step of the interval that led here; the next review takes the step above. */
  rung: number
  projected: boolean
  /** The last projected review of the topic: nothing follows it. */
  last?: boolean
  /** The earliest day index it may be moved to (the day after the quiz or review that led to it). */
  from?: number
}

/** Why a review has no day: the minutes are all used, or the final days hold only so many reviews. */
export type ReviewLossReason = 'minutes' | 'final_limit'

type Simulation = {
  days: PlanDay[]
  /** Topics whose learning did not fit before the last learning day, in order. */
  unplaced: PlanTopic[]
  /** Learned topics whose review before the exam found no day with room, and why. */
  reviewsLost: { topic: PlanTopic; reason: ReviewLossReason }[]
  unitMocks: number
  fullMockDays: string[]
  /** A topic was only partly placed: the caller removes it and plays again. */
  partial: PlanTopic | null
}

type SimOptions = {
  dates: string[]
  examDay: string | null
  input: PlanInput
  topics: PlanTopic[]
  order: PlanTopic[]
  unitMocks: boolean
  /** Time is short: one full mock exam instead of two, to leave the time to learning. */
  singleMock: boolean
  /** Topics taken out because time ran short (a topic only partly placed, and what needs it). */
  excluded: Set<string>
  /** Topics that can never fit a day, and what needs them: not learned, but not a sign of short time. */
  unschedulable: Set<string>
  doneMinutes: number
}

const itemId = (kind: PlanItemKind, key: string, date: string, part?: number) =>
  `${kind}:${key}:${date}${part ? `:${part}` : ''}`

function simulate(options: SimOptions): Simulation {
  const { dates, examDay, input, topics, unitMocks, singleMock, excluded, unschedulable, doneMinutes } = options
  const daily = clampMinutes(input.dailyMinutes)
  /** The minutes a day has for planned work: the daily minutes, less what is already done today. */
  const capOf = (index: number) => daily - (index === 0 ? doneMinutes : 0)
  const today = dates[0]
  const orderRank = new Map(topics.map((topic, index) => [topic.id, index]))
  const lastIndex = dates.length - 1

  const examIndex = examDay ? dates.indexOf(examDay) : -1
  // The last two days: the day before the exam and the exam day itself.
  const finalIndexes = new Set<number>()
  if (examIndex >= 0) {
    finalIndexes.add(examIndex)
    if (examIndex - 1 >= 0) finalIndexes.add(examIndex - 1)
  }

  // Full mock exams: the second two days before the exam or earlier, the first three days before that.
  const fullMockIndexes: number[] = []
  if (examIndex >= 0) {
    const needed = Math.max(0, 2 - Math.max(0, input.fullMocksDoneInFinalWeek))
    const second = examIndex - 2
    const first = Math.max(0, examIndex - 5)
    if (singleMock) {
      // The one mock: two days before the exam, or the latest day that still leaves a day before it.
      const only = second >= 0 ? second : examIndex - 1
      if (needed >= 1 && only >= 0) {
        fullMockIndexes.push(only)
        // A mock the day before the exam takes that day from the final review.
        finalIndexes.delete(only)
      }
    } else if (needed >= 1 && second >= 0) {
      if (needed >= 2 && first < second) fullMockIndexes.push(first)
      fullMockIndexes.push(second)
    }
  }

  const units = [...input.units].sort((a, b) => a.orderIndex - b.orderIndex)
  const mockUnits = new Map<string, PlanTopic[]>()
  if (unitMocks) {
    for (const unit of units) {
      if (input.unitMocksDone.includes(unit.id)) continue
      const members = topics.filter((topic) => topic.unitId === unit.id)
      if (members.length >= UNIT_MOCK_MIN_TOPICS) mockUnits.set(unit.id, members)
    }
  }

  const fixed = new Map<number, PlanItem[]>()
  const addFixed = (index: number, item: PlanItem) => {
    const list = fixed.get(index) ?? []
    list.push(item)
    fixed.set(index, list)
  }
  const isFullMockDay = (index: number) => fullMockIndexes.includes(index)
  /** Minutes of a day left after its mock exams (none on a day a mock fills or overfills). */
  const roomOf = (index: number) =>
    Math.max(0, capOf(index) - (fixed.get(index) ?? []).reduce((sum, item) => sum + item.minutes, 0))
  const allTopicIds = topics.map((topic) => topic.id)
  for (const index of fullMockIndexes) {
    addFixed(index, {
      id: itemId('full_mock', 'course', dates[index]),
      kind: 'full_mock',
      date: dates[index],
      title: 'Full mock exam',
      topicId: null,
      unitId: null,
      topicIds: allTopicIds,
      minutes: FULL_MOCK_MINUTES,
      done: false,
      part: null,
      projected: false,
      note: index === fullMockIndexes[fullMockIndexes.length - 1] ? 'Last full practice before the exam' : null,
      // Longer than the day: it is alone on it (nothing else fits, since the cap holds for the rest).
      overBudget: FULL_MOCK_MINUTES > capOf(index),
    })
  }

  // Unit mock exams are placed as the days are walked: a unit's mock is ready once all its topics are
  // learned (from the next day, or today for a unit learned already), and goes on the first day from
  // then on whose quizzes on its topics are done (that day's included) and that has room for it.
  let unitMockCount = 0
  const unitMockReady = new Map<string, number>()
  const unitMockDays = new Set<number>()
  // With 7 or more days to spare the first full mock goes the day after the last first quiz (rather
  // than 5 days before the exam), as a first look at what is still weak. It waits for the quizzes
  // as they are actually placed, so a quiz pushed back by a full day never lands after it.
  const firstMock = fixed.get(fullMockIndexes[0])?.find((item) => item.kind === 'full_mock')
  let firstMockSettled = singleMock || fullMockIndexes.length !== 2 || !firstMock
  /** A day the floating first mock may take: not a final or unit mock day, and one it fits when any day could. */
  const firstMockFits = (index: number) =>
    !finalIndexes.has(index) && !unitMockDays.has(index) && (FULL_MOCK_MINUTES <= capOf(index) || FULL_MOCK_MINUTES > daily)
  const moveFirstMockAfter = (quizzedIndex: number) => {
    if (firstMockSettled || !firstMock) return
    firstMockSettled = true
    let target = quizzedIndex + 1
    while (target <= lastIndex && !firstMockFits(target)) target += 1
    if (target > lastIndex || examIndex - target < EARLY_MOCK_DAYS || target >= fullMockIndexes[1]) return
    const from = fullMockIndexes[0]
    fixed.set(from, (fixed.get(from) ?? []).filter((item) => item !== firstMock))
    firstMock.date = dates[target]
    firstMock.id = itemId('full_mock', 'course', dates[target])
    firstMock.note = 'A first full practice now that you have learned everything'
    firstMock.overBudget = FULL_MOCK_MINUTES > capOf(target)
    addFixed(target, firstMock)
    fullMockIndexes[0] = target
  }

  // A unit that is already fully learned gets its mock as soon as there is room.
  for (const unit of units) {
    if ((mockUnits.get(unit.id) ?? [null]).every((topic) => topic?.learned)) unitMockReady.set(unit.id, 0)
  }

  /** The ladder step a topic's mastery earns (0.6 when it has none). */
  const rungOf = (topic: PlanTopic) =>
    Math.max(0, REVIEW_LADDER.indexOf(intervalFromMastery(topic.mastery ?? ASSUMED_MASTERY) as (typeof REVIEW_LADDER)[number]))
  /**
   * The last day a projected review may take: the latest day before the final review days with room
   * for one after its mock exams (a full mock day may have none), or -1 when there is none. Without
   * an exam date, the last day of the plan.
   */
  const reviewDeadline = (): number => {
    if (examIndex < 0) return lastIndex
    for (let index = Math.min(examIndex - 2, lastIndex); index >= 0; index -= 1) {
      if (!finalIndexes.has(index) && roomOf(index) >= REVIEW_MINUTES) return index
    }
    return -1
  }
  // A topic's last review is booked on a day with room for it, not forced over the cap on the
  // deadline. A day's room is what its mock exams leave, less the quizzes and reviews already due on it
  // (the scheduled ones go first, and earlier bookings count too).
  const bookLastReview = (preferred: number, earliest: number, deadline: number): number => {
    const booked = (index: number) =>
      spaced.filter((entry) => entry.target === index).reduce((sum, entry) => sum + (entry.kind === 'quiz' ? QUIZ_MINUTES : REVIEW_MINUTES), 0)
    const free = (index: number) => booked(index) + REVIEW_MINUTES <= roomOf(index)
    let chosen = -1
    // The preferred day or the nearest earlier one with room; failing that, the nearest later one.
    for (let index = preferred; index >= earliest && chosen < 0; index -= 1) if (free(index)) chosen = index
    for (let index = preferred + 1; index <= deadline && chosen < 0; index += 1) if (free(index)) chosen = index
    // No day has room: the preferred day. If it does not fit there either, the final review days take
    // it, and failing that the plan reports it (reviewsNotScheduled); it is never dropped silently.
    return chosen < 0 ? preferred : chosen
  }

  // Reviews at their due day, first quizzes for what is learned but never quizzed.
  const spaced: Spaced[] = []
  for (const topic of topics) {
    if (topic.reviewDueAt) {
      const dueDay = localDay(topic.reviewDueAt, input.timeZone)
      const gap = daysBetween(today, dueDay)
      // Due after the exam: not part of an exam plan.
      if (examIndex >= 0 && gap > examIndex) continue
      spaced.push({
        kind: 'review',
        topic,
        target: Math.max(0, Math.min(lastIndex, gap)),
        note: gap < 0 ? (gap === -1 ? 'Overdue by 1 day' : `Overdue by ${-gap} days`) : null,
        rung: rungOf(topic),
        projected: false,
      })
    } else if (topic.learned && !topic.quizzed) {
      spaced.push({ kind: 'quiz', topic, target: topic.learnedToday ? Math.min(1, lastIndex) : 0, note: null, rung: rungOf(topic) - 1, projected: false })
    }
  }

  const queue = options.order.filter((topic) => !excluded.has(topic.id) && !unschedulable.has(topic.id) && !topic.learned)
  const left = new Map(queue.map((topic) => [topic.id, learnMinutesLeft(topic)]))
  const totalMinutes = new Map(queue.map((topic) => [topic.id, learnMinutesLeft(topic)]))
  const partCount = new Map<string, number>()
  const parts = new Map<string, PlanItem[]>()
  // Topics learned now or by an earlier day of the plan.
  const learnedSet = new Set(topics.filter((topic) => topic.learned).map((topic) => topic.id))
  let partial: PlanTopic | null = null
  /** Every topic is learned (by now or by the plan) and every first quiz has its day. */
  const allFirstQuizzesPlaced = () =>
    topics.every((topic) => learnedSet.has(topic.id) || unschedulable.has(topic.id)) && !spaced.some((entry) => entry.kind === 'quiz')
  if (allFirstQuizzesPlaced()) moveFirstMockAfter(-1)

  const days: PlanDay[] = []
  // Days since learning ended (for the rest day), and how often a topic has been in a mixed practice.
  let phaseDays = 0
  const mixedUses = new Map<string, number>()
  const weakestOrder = (list: PlanTopic[]) =>
    [...list].sort(
      (a, b) =>
        (a.mastery ?? 0) - (b.mastery ?? 0) || (orderRank.get(a.id) ?? 0) - (orderRank.get(b.id) ?? 0)
    )

  for (let index = 0; index <= lastIndex; index += 1) {
    const date = dates[index]
    const items: PlanItem[] = []
    const isToday = index === 0

    if (finalIndexes.has(index)) {
      // Reviews of the weakest topics only: those learned, or learned by the plan, as many as fit.
      const learnedByNow = topics.filter((topic) => learnedSet.has(topic.id))
      const share = Math.max(0, Math.min(FINAL_DAY_REVIEWS, Math.max(1, Math.floor(daily / REVIEW_MINUTES)), Math.floor(capOf(index) / REVIEW_MINUTES)))
      const count = index === examIndex ? Math.min(EXAM_DAY_REVIEWS, share) : share
      // Reviews that are actually due come first (so none is lost), then everything else by need:
      // a suggested (projected) review waiting for a day is ranked with the other learned topics by
      // mastery, so it never takes the place of a weaker topic that has no review.
      const waiting = spaced
        .filter((entry) => entry.kind === 'review' && entry.target <= index)
        .sort((a, b) => (a.topic.mastery ?? 0) - (b.topic.mastery ?? 0) || (orderRank.get(a.topic.id) ?? 0) - (orderRank.get(b.topic.id) ?? 0))
      const chosen = new Map<string, Spaced | null>()
      for (const entry of waiting) if (!entry.projected && chosen.size < count && !chosen.has(entry.topic.id)) chosen.set(entry.topic.id, entry)
      const projectedFor = new Map<string, Spaced>()
      for (const entry of waiting) if (entry.projected && !projectedFor.has(entry.topic.id)) projectedFor.set(entry.topic.id, entry)
      for (const topic of weakestOrder(learnedByNow)) if (chosen.size < count && !chosen.has(topic.id)) chosen.set(topic.id, projectedFor.get(topic.id) ?? null)
      for (const entry of waiting) if (chosen.has(entry.topic.id)) spaced.splice(spaced.indexOf(entry), 1)
      for (const topic of weakestOrder(topics.filter((entry) => chosen.has(entry.id)))) {
        const entry = chosen.get(topic.id)
        items.push({
          id: itemId('review', topic.id, date),
          kind: 'review',
          date,
          title: `Review ${topic.name}`,
          topicId: topic.id,
          unitId: topic.unitId,
          topicIds: [topic.id],
          minutes: REVIEW_MINUTES,
          done: false,
          part: null,
          projected: entry?.projected ?? false,
          mastery: topic.mastery,
          note: entry ? entry.note : 'One of your weakest topics',
        })
      }
    } else {
      // A mock exam longer than the day leaves the capacity below zero, so nothing else joins it.
      let capacity = capOf(index)

      for (const mock of fixed.get(index) ?? []) {
        items.push(mock)
        capacity -= mock.minutes
      }

      // Reviews and quizzes due by now, oldest first and weakest first (projected ones after the rest).
      const due = spaced
        .filter((entry) => entry.target <= index)
        .sort(
          (a, b) =>
            Number(a.projected) - Number(b.projected) ||
            a.target - b.target ||
            (a.topic.mastery ?? 0) - (b.topic.mastery ?? 0) ||
            (orderRank.get(a.topic.id) ?? 0) - (orderRank.get(b.topic.id) ?? 0)
        )
      const placeDue = (entry: Spaced) => {
        const minutes = entry.kind === 'quiz' ? QUIZ_MINUTES : REVIEW_MINUTES
        if (minutes > capacity) return
        capacity -= minutes
        spaced.splice(spaced.indexOf(entry), 1)
        // The next review of this topic, one step up the ladder from this one. One that would fall past
        // the deadline moves up to it, staggered by topic so the last days are not one heap, onto a day
        // with room for it, and is the last: it is only added when the topic has had no review since
        // its quiz or this one is 4+ days back.
        if (!entry.last) {
          const deadline = reviewDeadline()
          const nextRung = Math.min(entry.rung + 1, REVIEW_LADDER.length - 1)
          const nextTarget = index + REVIEW_LADDER[nextRung]
          const clamped = examIndex >= 0 && nextTarget > deadline
          const wanted = examIndex >= 0 ? index < deadline && (!clamped || entry.kind === 'quiz' || deadline - index >= 4) : nextTarget <= lastIndex
          if (wanted) {
            const staggered = Math.max(index + 1, deadline - ((orderRank.get(entry.topic.id) ?? 0) % 4))
            spaced.push({
              kind: 'review',
              topic: entry.topic,
              target: clamped ? bookLastReview(staggered, index + 1, deadline) : nextTarget,
              note: null,
              rung: nextRung,
              projected: true,
              last: clamped,
              from: index + 1,
            })
          }
        }
        items.push({
          id: itemId(entry.kind, entry.topic.id, date),
          kind: entry.kind,
          date,
          title: entry.kind === 'quiz' ? `Quiz: ${entry.topic.name}` : `Review ${entry.topic.name}`,
          topicId: entry.topic.id,
          unitId: entry.topic.unitId,
          topicIds: [entry.topic.id],
          minutes,
          done: false,
          part: null,
          projected: entry.projected,
          mastery: entry.topic.mastery,
          note: entry.note,
        })
      }

      // One unit mock exam a day, after its topics' quizzes, when the day has room (not a full mock day).
      const placeUnitMock = () => {
        if (isFullMockDay(index)) return
        for (const unit of units) {
          const members = mockUnits.get(unit.id)
          const from = unitMockReady.get(unit.id)
          if (!members || from === undefined || from > index) continue
          if (spaced.some((entry) => entry.kind === 'quiz' && members.includes(entry.topic))) continue
          if (capacity < UNIT_MOCK_MINUTES) break
          mockUnits.delete(unit.id)
          unitMockDays.add(index)
          unitMockCount += 1
          capacity -= UNIT_MOCK_MINUTES
          items.push({
            id: itemId('unit_mock', unit.id, date),
            kind: 'unit_mock',
            date,
            title: `Mock exam: ${unit.title}`,
            topicId: null,
            unitId: unit.id,
            topicIds: members.map((topic) => topic.id),
            minutes: UNIT_MOCK_MINUTES,
            done: false,
            part: null,
            projected: false,
            note: null,
          })
          break
        }
      }

      // Quizzes and scheduled reviews, then a unit mock that is ready, then projected reviews: a
      // projection is a suggestion, and must not crowd out a quiz or a unit mock now that a day
      // cannot run over.
      for (const entry of due.filter((item) => !item.projected)) placeDue(entry)
      placeUnitMock()
      for (const entry of due.filter((item) => item.projected)) placeDue(entry)

      // New learning in what is left of the day.
      while (queue.length > 0) {
        const topic = queue[0]
        const need = left.get(topic.id) ?? 0
        if (need <= 0) {
          queue.shift()
          continue
        }
        // The whole topic if it fits; else the largest part of what is left of the day that leaves a
        // remainder later days can finish (every part at least MIN_PART_MINUTES). The day never runs over.
        let take = 0
        if (need <= capacity) take = need
        else {
          // Parts of 15 or more throughout if that works; else the last part may be shorter (25 left on a
          // 20-minute day is 15 + 10), as long as it can, and only as a last resort the shortest.
          for (const minLast of [MIN_PART_MINUTES, PREFERRED_FINAL_PART_MINUTES, MIN_FINAL_PART_MINUTES]) {
            for (let part = Math.min(capacity, need - minLast); part >= MIN_PART_MINUTES && take === 0; part -= 1) {
              if (fitsInDays(need - part, daily, { minLast })) take = part
            }
          }
        }
        if (take === 0) break

        capacity -= take
        left.set(topic.id, need - take)
        const number = (partCount.get(topic.id) ?? 0) + 1
        partCount.set(topic.id, number)
        const item: PlanItem = {
          id: itemId('learn', topic.id, date, number > 1 || take < need ? number : undefined),
          kind: 'learn',
          date,
          title: `Learn ${topic.name}`,
          topicId: topic.id,
          unitId: topic.unitId,
          topicIds: [topic.id],
          minutes: take,
          done: false,
          part: null,
          projected: false,
          note: topic.examRelevant ? 'On past exams' : topic.started ? 'You have started this one' : null,
        }
        items.push(item)
        parts.set(topic.id, [...(parts.get(topic.id) ?? []), item])

        if (take < need) {
          // Out of time for today; the rest continues tomorrow.
          break
        }
        queue.shift()
        learnedSet.add(topic.id)
        // Learned by the plan: its first quiz is the next day.
        if (!topic.reviewDueAt) spaced.push({ kind: 'quiz', topic, target: index + 1, note: null, rung: rungOf(topic) - 1, projected: false })
        // The last topic of a unit to be learned makes the unit's mock exam ready, from the next day.
        const members = topic.unitId ? mockUnits.get(topic.unitId) : undefined
        if (topic.unitId && members && !unitMockReady.has(topic.unitId) && members.every((member) => learnedSet.has(member.id))) {
          unitMockReady.set(topic.unitId, index + 1)
        }
      }

      // The first full mock follows the last first quiz, once that quiz has its day.
      if (allFirstQuizzesPlaced()) moveFirstMockAfter(index)

      // Everything is learned and the exam has a date: the free time goes to mixed practice, except the
      // 7th day of each run, which is left free to rest.
      if (examIndex >= 0 && excluded.size === 0 && queue.length === 0) {
        phaseDays += 1
        const rest = phaseDays % REST_EVERY === 0
        const pool = topics.filter((topic) => learnedSet.has(topic.id))
        let blocks = 0
        // The sets already on this day, and the topics in them: a day never holds the same set twice.
        const setsToday = new Set<string>()
        const mixedToday = new Set<string>()
        while (!rest && pool.length >= 2 && capacity >= MIXED_MIN_MINUTES && blocks < MIXED_MAX_PER_DAY) {
          // The weakest topics first (not yet quizzed counts as middling), those on past exams ahead,
          // and ones not practised lately ahead of ones that were.
          const score = (topic: PlanTopic) =>
            1 - (topic.mastery ?? 0.5) + (topic.examRelevant ? 0.3 : 0) - 0.2 * (mixedUses.get(topic.id) ?? 0)
          const ranked = [...pool].sort((a, b) => score(b) - score(a) || (orderRank.get(a.id) ?? 0) - (orderRank.get(b.id) ?? 0))
          const setKey = (list: PlanTopic[]) => list.map((topic) => topic.id).sort().join()
          // The best set; if the day already has it, the best of the topics not yet mixed today.
          let picked = ranked.slice(0, MIXED_SET_SIZE)
          if (setsToday.has(setKey(picked))) picked = ranked.filter((topic) => !mixedToday.has(topic.id)).slice(0, MIXED_SET_SIZE)
          // No other set: the one block keeps the day's mixed practice (up to MIXED_MAX_MINUTES).
          if (picked.length < 2 || setsToday.has(setKey(picked))) break
          setsToday.add(setKey(picked))
          for (const topic of picked) mixedToday.add(topic.id)
          picked.sort((a, b) => (orderRank.get(a.id) ?? 0) - (orderRank.get(b.id) ?? 0))
          const minutes = Math.min(capacity, MIXED_MAX_MINUTES)
          blocks += 1
          capacity -= minutes
          for (const topic of picked) mixedUses.set(topic.id, (mixedUses.get(topic.id) ?? 0) + 1)
          const names = picked.map((topic) => topic.name)
          items.push({
            id: itemId('mixed', String(blocks), date),
            kind: 'mixed',
            date,
            title: `Mixed practice: ${names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`,
            topicId: null,
            unitId: null,
            topicIds: picked.map((topic) => topic.id),
            minutes,
            done: false,
            part: null,
            projected: false,
            note: null,
          })
        }
      }
    }

    days.push({
      date,
      isToday,
      isExamDay: index === examIndex,
      isFinalReview: finalIndexes.has(index),
      items,
      minutes: items.reduce((sum, item) => sum + item.minutes, 0),
      doneMinutes: 0,
    })
  }

  // A topic that was started but not finished before the learning days ran out.
  for (const topic of queue) {
    const placedMinutes = (parts.get(topic.id) ?? []).reduce((sum, item) => sum + item.minutes, 0)
    if (placedMinutes > 0 && placedMinutes < (totalMinutes.get(topic.id) ?? 0)) {
      partial = topic
      break
    }
  }

  // Parts know how many there are: "part 1 of 2".
  for (const list of parts.values()) {
    if (list.length > 1) list.forEach((item, position) => (item.part = { number: position + 1, of: list.length }))
  }

  const unplaced = queue.filter((topic) => (left.get(topic.id) ?? 0) > 0)
  // A review still waiting at the end, with no review of the topic on or after its day. It goes to the
  // latest day before the final days with room for it (not before its topic was learned or the review
  // that led to it); only when there is none is it lost, and the reason says which limit was hit.
  const reviewsLost: Simulation['reviewsLost'] = []
  if (examIndex >= 0) {
    const waiting = spaced
      .filter((entry) => entry.kind === 'review')
      .sort((a, b) => (a.topic.mastery ?? 0) - (b.topic.mastery ?? 0) || (orderRank.get(a.topic.id) ?? 0) - (orderRank.get(b.topic.id) ?? 0))
    const seen = new Set<string>()
    for (const entry of waiting) {
      if (seen.has(entry.topic.id)) continue
      seen.add(entry.topic.id)
      const reviewed = days.some((day, index) => index >= entry.target && day.items.some((item) => item.kind === 'review' && item.topicId === entry.topic.id))
      if (reviewed) continue
      // Not before the topic's latest learning, quiz or review: a review needs something to follow.
      const latest = days.reduce((last, day, index) => (day.items.some((item) => item.topicId === entry.topic.id && item.kind !== 'mixed') ? index : last), -1)
      const from = Math.max(entry.from ?? 0, latest + 1)
      const eligible = Array.from({ length: Math.max(0, Math.min(examIndex, lastIndex) - from + 1) }, (_, offset) => from + offset).filter((index) => !finalIndexes.has(index))
      const slot = eligible
        .reverse()
        .find((index) => days[index].minutes + REVIEW_MINUTES <= capOf(index) && !days[index].items.some((item) => item.kind === 'review' && item.topicId === entry.topic.id))
      if (slot !== undefined) {
        const topic = entry.topic
        days[slot].items.push({
          id: itemId('review', topic.id, dates[slot]),
          kind: 'review',
          date: dates[slot],
          title: `Review ${topic.name}`,
          topicId: topic.id,
          unitId: topic.unitId,
          topicIds: [topic.id],
          minutes: REVIEW_MINUTES,
          done: false,
          part: null,
          projected: entry.projected,
          mastery: topic.mastery,
          note: entry.note,
        })
        days[slot].minutes += REVIEW_MINUTES
        continue
      }
      // No day before the final days has room. If the final days had minutes to spare, it was their
      // limit on reviews (and no earlier day to turn to) that cost it, and more study time would not help.
      const finalRoom = [...finalIndexes].some((index) => index >= entry.target && capOf(index) - days[index].minutes >= REVIEW_MINUTES)
      const reason: ReviewLossReason = finalRoom && eligible.length === 0 ? 'final_limit' : 'minutes'
      reviewsLost.push({ topic: entry.topic, reason })
    }
  }
  return { days, unplaced, reviewsLost, unitMocks: unitMockCount, fullMockDays: fullMockIndexes.map((i) => dates[i]), partial }
}

// ---------------------------------------------------------------------------------------
// The plan

const kindOrder: Record<PlanItemKind, number> = { review: 0, quiz: 1, learn: 2, mixed: 3, unit_mock: 4, full_mock: 5 }

function doneItems(input: PlanInput, today: string, topicById: Map<string, PlanTopic>): PlanItem[] {
  const items: PlanItem[] = []
  for (const entry of input.doneToday) {
    if (entry.kind === 'mock') {
      items.push({
        id: `mock:${entry.examId}:${today}`,
        kind: 'full_mock',
        date: today,
        title: entry.name,
        topicId: null,
        unitId: null,
        topicIds: [],
        // The time it took, so today's room is what is really left.
        minutes: Math.max(0, Math.round(entry.minutes)),
        done: true,
        part: null,
        projected: false,
        note: null,
      })
      continue
    }
    const topic = topicById.get(entry.topicId)
    if (!topic) continue
    const minutes = entry.kind === 'learn' ? learnMinutesLeft({ ...topic, learned: false, started: false }) : entry.kind === 'quiz' ? QUIZ_MINUTES : REVIEW_MINUTES
    items.push({
      id: `${entry.kind}:${topic.id}:${today}:done`,
      kind: entry.kind,
      date: today,
      title: entry.kind === 'learn' ? `Learn ${topic.name}` : entry.kind === 'quiz' ? `Quiz: ${topic.name}` : `Review ${topic.name}`,
      topicId: topic.id,
      unitId: topic.unitId,
      topicIds: [topic.id],
      minutes,
      done: true,
      part: null,
      projected: false,
      note: null,
    })
  }
  return items
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function hoursLabel(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  const hours = Math.round((minutes / 60) * 2) / 2
  return `${hours} hours`
}

/** Builds the plan from the student's current state. Pure: the same input always gives the same plan. */
export function buildPlan(input: PlanInput): Plan {
  const today = localDay(input.now, input.timeZone)
  const dailyMinutes = clampMinutes(input.dailyMinutes)
  const topics = [...input.topics].sort((a, b) => a.orderIndex - b.orderIndex)
  const topicById = new Map(topics.map((topic) => [topic.id, topic]))
  const examDate = isDayString(input.examDate) ? input.examDate : null
  const mode: Plan['mode'] = examDate ? 'exam' : 'rolling'
  const daysToExam = examDate ? daysBetween(today, examDate) : null

  const base: Plan = {
    status: 'ready',
    today,
    mode,
    examDate,
    daysToExam,
    dailyMinutes,
    days: [],
    short: false,
    shortMessage: null,
    unitMocksSkipped: false,
    fullMocksReduced: false,
    notScheduled: null,
    tooLongForDay: null,
    reviewsNotScheduled: null,
    mockNote: null,
    remaining: { topics: 0, minutes: 0 },
  }

  if (topics.length === 0) return { ...base, status: 'no_topics' }
  if (daysToExam !== null && daysToExam < 0) return { ...base, status: 'exam_passed' }

  const length = daysToExam !== null ? Math.min(daysToExam + 1, MAX_PLAN_DAYS) : ROLLING_DAYS
  const dates = Array.from({ length }, (_, index) => addDays(today, index))
  const examDay = examDate && dates.includes(examDate) ? examDate : null

  const done = doneItems(input, today, topicById)
  const doneMinutes = done.reduce((sum, item) => sum + item.minutes, 0)

  const todo = topics.filter((topic) => !topic.learned)
  const remainingMinutes = todo.reduce((sum, topic) => sum + learnMinutesLeft(topic), 0)

  // Topics that no number of days can fit (longer than a day, and no split into parts of at least
  // MIN_PART_MINUTES fits days of this length), and what needs them first. They are left out of every
  // run, so they neither hold up the topics after them nor count as time being short.
  const tooLong = todo.filter((topic) => !fitsInDays(learnMinutesLeft(topic), dailyMinutes))
  const unschedulable = new Set(tooLong.map((topic) => topic.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const topic of todo) {
      if (!unschedulable.has(topic.id) && topic.prerequisiteIds.some((id) => unschedulable.has(id))) {
        unschedulable.add(topic.id)
        grew = true
      }
    }
  }
  const schedulable = todo.filter((topic) => !unschedulable.has(topic.id))
  const schedulableMinutes = schedulable.reduce((sum, topic) => sum + learnMinutesLeft(topic), 0)

  const run = (config: { examFirst: boolean; unitMocks: boolean; singleMock?: boolean }): Simulation => {
    const excluded = new Set<string>()
    let result: Simulation
    // A topic that was only partly placed is taken out and the plan is laid out again, so the
    // time it took goes to topics that fit whole.
    for (let attempt = 0; ; attempt += 1) {
      result = simulate({
        dates,
        examDay,
        input,
        topics,
        order: learnOrder(topics, { examFirst: config.examFirst }),
        unitMocks: config.unitMocks,
        singleMock: config.singleMock ?? false,
        excluded,
        unschedulable,
        doneMinutes,
      })
      if (!result.partial || attempt > topics.length) break
      excluded.add(result.partial.id)
      // What builds on a topic that is left out cannot be learned first either.
      for (let grew = true; grew; ) {
        grew = false
        for (const topic of topics) {
          if (!excluded.has(topic.id) && !unschedulable.has(topic.id) && !topic.learned && topic.prerequisiteIds.some((id) => excluded.has(id))) {
            excluded.add(topic.id)
            grew = true
          }
        }
      }
    }
    return { ...result, unplaced: [...result.unplaced.filter((topic) => !excluded.has(topic.id)), ...topics.filter((t) => excluded.has(t.id))] }
  }

  // First the plan in course order with every mock exam. If that leaves topics out and the exam date
  // is inside the plan, the time is tight and mock exams give way to learning, in this order: the
  // optional unit mock exams, then the earlier of the two full mocks (one stays, at least 2 days
  // before the exam). If topics are still left out, the time is short: past-exam topics go first.
  // A unit mock needs a day with room for it: below UNIT_MOCK_MINUTES a day, none are planned.
  const eligibleUnitMocks = dailyMinutes >= UNIT_MOCK_MINUTES && input.units.some(
    (unit) =>
      !input.unitMocksDone.includes(unit.id) &&
      topics.filter((topic) => topic.unitId === unit.id).length >= UNIT_MOCK_MIN_TOPICS
  )
  const mocksWanted = Math.max(0, 2 - Math.max(0, input.fullMocksDoneInFinalWeek))
  let chosen = run({ examFirst: false, unitMocks: true })
  let short = false
  let unitMocksSkipped = false
  let fullMocksReduced = false
  if (chosen.unplaced.length > 0 && examDay) {
    unitMocksSkipped = eligibleUnitMocks
    chosen = run({ examFirst: false, unitMocks: false })
    if (chosen.unplaced.length > 0) {
      fullMocksReduced = mocksWanted >= 2
      chosen = run({ examFirst: false, unitMocks: false, singleMock: true })
    }
    if (chosen.unplaced.length > 0) {
      chosen = run({ examFirst: true, unitMocks: false, singleMock: true })
      short = chosen.unplaced.length > 0
    }
  }

  const days: PlanDay[] = chosen.days.map((day) => {
    const items = [...day.items]
    if (day.isToday) items.unshift(...done)
    // Display order within a day: reviews, quizzes, learning, then mock exams; done items first.
    items.sort((a, b) => Number(b.done) - Number(a.done) || kindOrder[a.kind] - kindOrder[b.kind])
    return {
      ...day,
      items,
      minutes: items.filter((item) => !item.done).reduce((sum, item) => sum + item.minutes, 0),
      doneMinutes: items.filter((item) => item.done).reduce((sum, item) => sum + item.minutes, 0),
    }
  })

  const unplaced = [...chosen.unplaced]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((topic) => ({ id: topic.id, name: topic.name }))
  const placedMinutes = days.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'learn' && !item.done).reduce((s, item) => s + item.minutes, 0),
    0
  )

  let shortMessage: string | null = null
  if (short) {
    const total = schedulable.length
    const fits = total - unplaced.length
    const anyRelevant = schedulable.some((topic) => topic.examRelevant)
    const needs = hoursLabel(schedulableMinutes)
    const opening =
      fits === 0
        ? `Time is short. The ${total === 1 ? 'topic' : `${total} topics`} left ${total === 1 ? 'needs' : 'need'} about ${needs}, and there is no room for ${total === 1 ? 'it' : 'them'} before your exam.`
        : `Time is short. ${fits} of the ${plural(total, 'topic')} left fit before your exam (about ${hoursLabel(placedMinutes)} of the ${needs} they need).`
    shortMessage =
      opening +
      (fits === 0 ? '' : anyRelevant ? ' Topics that appear on your past exams come first, then course order.' : ' They are in course order.') +
      (unitMocksSkipped ? ' The mock exams after each unit are left out to make room.' : '') +
      (fullMocksReduced ? ' Only one full mock exam is planned, so there is more time to learn.' : '') +
      ' Add study time or move the date to fit more.'
  }

  let mockNote: string | null = null
  if (examDate && daysToExam !== null) {
    const needed = Math.max(0, 2 - input.fullMocksDoneInFinalWeek)
    if (fullMocksReduced && chosen.fullMockDays.length === 1) {
      mockNote = 'To leave time for learning, only one full mock exam is planned before your exam.'
    } else if (needed > 0 && chosen.fullMockDays.length < needed) {
      mockNote =
        chosen.fullMockDays.length === 0
          ? 'Your exam is less than 2 days away, so there is no room for a full mock exam. Take one now if you can.'
          : 'There is room for only one full mock exam before the exam.'
    }
  }

  return {
    ...base,
    days,
    short,
    shortMessage,
    unitMocksSkipped,
    fullMocksReduced,
    mockNote,
    notScheduled: unplaced.length > 0 ? { reason: short ? 'short' : 'later', topics: unplaced } : null,
    tooLongForDay:
      unschedulable.size > 0
        ? {
            topics: tooLong.map((topic) => ({ id: topic.id, name: topic.name })),
            dependents: todo.filter((topic) => unschedulable.has(topic.id) && !tooLong.includes(topic)).map((topic) => ({ id: topic.id, name: topic.name })),
          }
        : null,
    reviewsNotScheduled: chosen.reviewsLost.length > 0 ? chosen.reviewsLost.map(({ topic, reason }) => ({ id: topic.id, name: topic.name, reason })) : null,
    remaining: { topics: todo.length, minutes: remainingMinutes },
  }
}

/** Today's items from the plan, in the order to do them (done ones first). */
export const todayItems = (plan: Plan): PlanItem[] => plan.days.find((day) => day.isToday)?.items ?? []
