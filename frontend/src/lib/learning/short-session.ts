/**
 * The 10-minute session (spec 18.8). `shortSessionPlan` picks what to offer a student with a few minutes, in order:
 * 1. When concepts are due across the course: a review session of at most 6 items, with at most 2 closing retests.
 * 2. Otherwise, when the current plan topic has `readAt` and no `recallAt` (and the AI is up): one recall card on that topic.
 * 3. Otherwise: a 4-question mini quiz from the current plan topic's concepts, served as a short review session that takes in
 *    concepts that are not due, with no closing retests (`ItemSession kind='review'`, `meta.short = true`). It is not a
 *    `QuizAttempt` (D7), so it never touches best scores.
 *
 * Each plan reports its estimate: a multiple choice item about a minute, a short answer two (a mix of both is taken as a minute
 * and a half), a recall card five. With the AI down the recall card is skipped and items are rule-graded only, a minute each.
 * Pure: the route (`app/api/projects/[projectId]/short-session/route.ts`) and Home read the state and start the session.
 */

/** Items in the review session, and its closing retests at most. */
export const SHORT_REVIEW_ITEMS = 6
export const SHORT_REVIEW_RETESTS = 2
/** Questions in the mini quiz. */
export const SHORT_QUIZ_ITEMS = 4
/** Minutes for one recall card. */
export const RECALL_CARD_MINUTES = 5

export type ShortSessionState = {
  courseId: string
  /** Concepts due across the course. */
  due: number
  /** The topic the plan is on now, with the stages the next-activity cascade reads. Null when there is none. */
  currentTopic: { id: string; readAt: Date | null; recallAt: Date | null } | null
  ai: 'up' | 'down'
}

export type ShortSessionPlan = {
  kind: 'review' | 'recall' | 'mini_quiz'
  /** Items in the session; none for a recall card. */
  limit?: number
  /** Closing retests at most; none for a recall card. */
  retestCap?: number
  minutes: number
  /**
   * How many questions the session will have, once it is known (`sizeShortSession`): `exact` when they are all ready, else
   * `count` is the most it can have, because some are still to be written. Absent: only `limit` is known, which is a ceiling.
   */
  size?: { count: number; exact: boolean }
  /** Where a recall card opens; a review or mini quiz is started by the route (it makes the session), so it has none. */
  href: string | null
}

const itemMinutes = (count: number, ai: 'up' | 'down') => Math.ceil(count * (ai === 'down' ? 1 : 1.5))

/** What to offer, or null when there is nothing to do in a short session (nothing due and no topic to quiz). */
export function shortSessionPlan(state: ShortSessionState): ShortSessionPlan | null {
  if (state.due > 0) {
    const limit = Math.min(SHORT_REVIEW_ITEMS, state.due)
    return { kind: 'review', limit, retestCap: SHORT_REVIEW_RETESTS, minutes: itemMinutes(limit, state.ai), href: null }
  }
  const topic = state.currentTopic
  if (!topic) return null
  if (state.ai === 'up' && topic.readAt && !topic.recallAt) {
    return { kind: 'recall', minutes: RECALL_CARD_MINUTES, href: `/courses/${state.courseId}/topics/${topic.id}?view=recall` }
  }
  return { kind: 'mini_quiz', limit: SHORT_QUIZ_ITEMS, retestCap: 0, minutes: itemMinutes(SHORT_QUIZ_ITEMS, state.ai), href: null }
}

/**
 * The plan with the size the session really has: `ready` questions are in the bank, `toWrite` still have to be written (and a
 * failed write leaves the session shorter, so the card says "up to"). The estimate follows the size, not the ceiling.
 */
export function sizeShortSession(plan: ShortSessionPlan, size: { ready: number; toWrite: number }, ai: 'up' | 'down'): ShortSessionPlan {
  if (plan.kind === 'recall') return plan
  const count = Math.min(plan.limit ?? size.ready + size.toWrite, size.ready + size.toWrite)
  return { ...plan, size: { count, exact: size.toWrite === 0 }, minutes: itemMinutes(count, ai) }
}

/** The name of the offer wherever it is shown: the Home and Review card, and the session's own header. */
export const SHORT_SESSION_NAME = 'Quick practice'

/**
 * The one duration statement for the quick practice, "About 5 minutes · up to 3 questions": the time first, then what is in it.
 * The card, the Review page and the session header all say it this way (the heading no longer promises ten minutes).
 */
export function shortSessionLabel(plan: ShortSessionPlan): string {
  const time = `About ${plan.minutes} minutes`
  if (plan.kind === 'recall') return `${time} · one recall card`
  const count = plan.size?.count ?? plan.limit ?? 0
  const lead = plan.size && !plan.size.exact ? 'up to ' : ''
  const noun = plan.kind === 'review' ? (count === 1 ? 'review' : 'reviews') : count === 1 ? 'question' : 'questions'
  return `${time} · ${lead}${count} ${noun}`
}
