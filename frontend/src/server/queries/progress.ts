import { prisma } from '@/lib/db/prisma'
import { calibrationFromGroups } from '@/lib/learning/calibration'
import { conceptMastery, type ConceptKind } from '@/lib/learning/concept-mastery'
import { stateFromMemoryRow } from '@/lib/learning/mastery'
import { addDays, localDay, weekStart } from '@/lib/learning/plan'
import { zonedTimeToUtc } from '@/lib/learning/study-plan-time'

/**
 * What a student sees about their own unassisted ability (spec §10). Every figure is filtered by the user id,
 * counts answers (one item in one session, however many concepts it tests; credit inferred from a neighbouring concept is
 * not one) and leaves out the warm-up,
 * a pretest before anything was taught. The sums are done in the database.
 */

/** A week with fewer first tries than this says too little to be a number. */
export const MIN_WEEK_EVENTS = 10
/** Weeks the accuracy line looks back. */
export const WEEKS_SHOWN = 12
/** Days of answers calibration looks back over (said in the panel). */
export const CALIBRATION_DAYS = 90
const FOCUS_SIZE = 3
/** A concept that failed this many reviews in a row is stuck, not unlucky. */
const PLATEAU_FAILS = 2

export type FocusReason = 'misconception' | 'plateau' | 'fading'

export type Progress = {
  /**
   * Oldest first. `week` is the Monday of the week in the student's zone (YYYY-MM-DD). `accuracy` (0 to 1) is
   * the mean score over first tries made without help: level-0 answers, plus level-1 failures (a miss that
   * then needed a hint, tutor turn or reveal) counted as 0. `n` is those tries (answers, not events).
   */
  weekly: { week: string; n: number; accuracy: number }[]
  /** Level-0 answers with a confidence tap, over the last CALIBRATION_DAYS days. */
  calibration: ReturnType<typeof calibrationFromGroups>
  /** The share (0 to 1) of this week's answers that had any help: a hint, tutor turn, reveal or worked example (level 1 or more, §3.3). */
  assistedShare: number
  /** The answers that share is out of; with none, there is no share to show. */
  weekAnswers: number
  /**
   * The Monday (YYYY-MM-DD, the student's zone) of the week of the student's first answer in this course; null before any.
   * A warm-up, an inferred credit and an instruction are not answers. The panel says early weeks are low during the first
   * four (spec 18.10).
   */
  firstWeekStart: string | null
  /** The Monday of the current week, in the same form, so a reader can count the weeks since `firstWeekStart`. */
  thisWeek: string
  /** `topicName` is where the idea lives; `misconception` is the mix-up on record, for the one that has a live one. */
  focus: { conceptId: string; name: string; topicName: string; reason: FocusReason; misconception: string | null }[]
}

const weekOf = (at: Date, timeZone: string) => weekStart(localDay(at, timeZone))

/** The instant the local day starts. */
function startOfLocalDay(day: string, timeZone: string): Date {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  return zonedTimeToUtc({ year, month, day: dayOfMonth }, 0, 0, timeZone)
}

async function focusConcepts(userId: string, projectId: string, now: Date) {
  const rows = await prisma.conceptMemory.findMany({
    where: { userId, projectId, concept: { status: 'active', topic: { userConfirmed: true } } },
    include: { concept: { select: { name: true, kind: true, topicId: true, topic: { select: { name: true } } } } },
  })
  const learned = rows.map((row) => {
    const state = stateFromMemoryRow(row)
    const { label, retrievability } = conceptMastery(state, row.concept.kind as ConceptKind, now)
    return { row, retrievability, answered: state.level0Scores.length > 0 && state.card !== null && label !== 'not_started' && label !== 'inferred' }
  })

  const picked = new Set<string>()
  // The same idea twice in one topic (an extraction that ran again) with the same thing to say reads as one card.
  // The same name in two topics is two ideas, told apart by the topic each card names.
  const said = new Set<string>()
  const focus: Progress['focus'] = []
  const take = (list: typeof learned, reason: FocusReason) => {
    for (const item of list) {
      if (focus.length >= FOCUS_SIZE) return
      if (picked.has(item.row.conceptId)) continue
      const misconception = item.row.misconception?.trim() || null
      const same = `${item.row.concept.topicId}\u0000${item.row.concept.name.trim().toLowerCase()}\u0000${(misconception ?? '').toLowerCase()}`
      if (said.has(same)) continue
      picked.add(item.row.conceptId)
      said.add(same)
      focus.push({ conceptId: item.row.conceptId, name: item.row.concept.name, topicName: item.row.concept.topic.name, reason, misconception })
    }
  }
  const time = (date: Date | null) => date?.getTime() ?? 0

  // 1. A live misconception, the newest first.
  take(
    learned.filter((item) => !!item.row.misconception).sort((a, b) => time(b.row.misconceptionAt) - time(a.row.misconceptionAt)),
    'misconception'
  )
  // 2. A concept that keeps failing, the longest run first.
  take(
    learned
      .filter((item) => item.row.consecutiveFails >= PLATEAU_FAILS)
      .sort((a, b) => b.row.consecutiveFails - a.row.consecutiveFails || a.retrievability - b.retrievability),
    'plateau'
  )
  // 3. The learned concept with the lowest retrievability.
  take(
    learned.filter((item) => item.answered).sort((a, b) => a.retrievability - b.retrievability),
    'fading'
  )
  return focus
}

export async function getProgress(
  userId: string,
  projectId: string,
  options: { timeZone?: string; now?: Date } = {}
): Promise<Progress> {
  const { timeZone = 'UTC', now = new Date() } = options
  const thisWeek = weekOf(now, timeZone)
  const since = startOfLocalDay(addDays(thisWeek, -7 * (WEEKS_SHOWN - 1)), timeZone)

  const weekStartsAt = startOfLocalDay(thisWeek, timeZone)
  const calibrationSince = new Date(now.getTime() - CALIBRATION_DAYS * 24 * 60 * 60 * 1000)

  // An answer is one item in one session: an answer to an item that tests several concepts writes an event for each, and
  // a step surrendered and then finished writes two, so every figure here groups events back into answers first.
  const [weekly, confidence, week, first, focus] = await Promise.all([
    // First tries made without help: level 0 at its score, level 1 (a miss, then a hint, tutor turn or reveal) as 0.
    // Postgres starts its weeks on Monday; created_at is UTC without a zone, so it is read as UTC first.
    prisma.$queryRaw<{ week: string; n: number; accuracy: number }[]>`
      SELECT to_char(date_trunc('week', (at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS week,
             count(*)::int AS n,
             avg(accuracy)::float8 AS accuracy
      FROM (
        SELECT min(created_at) AS at, avg(CASE WHEN assistance = 0 THEN score ELSE 0 END) AS accuracy
        FROM evidence_events
        WHERE user_id = ${userId} AND project_id = ${projectId}
          AND source NOT IN ('implicit', 'warmup') AND assistance <= 1
          AND created_at >= ${since}
        GROUP BY item_key, session_key
      ) answers
      GROUP BY 1
      HAVING count(*) >= ${MIN_WEEK_EVENTS}
      ORDER BY 1`,
    prisma.$queryRaw<{ confidence: number; n: number; sum_score: number; sum_squares: number }[]>`
      SELECT confidence::float8 AS confidence, count(*)::int AS n,
             sum(score)::float8 AS sum_score, sum(score * score)::float8 AS sum_squares
      FROM (
        SELECT max(confidence) AS confidence, avg(score) AS score
        FROM evidence_events
        WHERE user_id = ${userId} AND project_id = ${projectId}
          AND source NOT IN ('implicit', 'warmup') AND assistance = 0 AND confidence IS NOT NULL
          AND created_at >= ${calibrationSince}
        GROUP BY item_key, session_key
      ) answers
      GROUP BY confidence`,
    prisma.$queryRaw<{ answers: number; assisted: number }[]>`
      SELECT count(*)::int AS answers, count(*) FILTER (WHERE help >= 1)::int AS assisted
      FROM (
        SELECT max(assistance) AS help
        FROM evidence_events
        WHERE user_id = ${userId} AND project_id = ${projectId}
          AND source NOT IN ('implicit', 'warmup', 'instruction') AND created_at >= ${weekStartsAt}
        GROUP BY item_key, session_key
      ) answers`,
    prisma.$queryRaw<{ week: string | null }[]>`
      SELECT to_char(date_trunc('week', (min(created_at) AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS week
      FROM evidence_events
      WHERE user_id = ${userId} AND project_id = ${projectId}
        AND source NOT IN ('implicit', 'warmup', 'instruction')`,
    focusConcepts(userId, projectId, now),
  ])
  const weekAnswers = week[0]?.answers ?? 0
  const weekAssisted = week[0]?.assisted ?? 0

  return {
    weekly: weekly.map((row) => ({ week: row.week, n: row.n, accuracy: row.accuracy })),
    calibration: calibrationFromGroups(
      confidence.map((row) => ({ confidence: row.confidence, n: row.n, sumScore: row.sum_score, sumSquares: row.sum_squares }))
    ),
    weekAnswers,
    assistedShare: weekAnswers ? weekAssisted / weekAnswers : 0,
    firstWeekStart: first[0]?.week ?? null,
    thisWeek,
    focus,
  }
}
