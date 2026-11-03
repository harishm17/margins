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

/** The line under "Have 10 minutes?" (copy drafts, spec 18.8). */
export function shortSessionLabel(plan: ShortSessionPlan): string {
  if (plan.kind === 'review') return `${plan.limit ?? 0} ${plan.limit === 1 ? 'review' : 'reviews'}, about ${plan.minutes} minutes`
  if (plan.kind === 'recall') return `One recall card, about ${plan.minutes} minutes`
  return `A ${plan.limit ?? SHORT_QUIZ_ITEMS}-question check, about ${plan.minutes} minutes`
}
