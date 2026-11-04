/**
 * The database half of the 10-minute session (spec 18.8): the state `shortSessionPlan` reads, and the quick-pass choice
 * that triage stores. Server only.
 */

import { prisma } from '@/lib/db/prisma'
import { blockedCode } from '@/lib/ai/status'
import { getAiStatus } from '@/server/ai-status'
import { getPlanData } from '@/server/queries/plan'
import { todayItems, type Plan } from './plan'
import { countDueConcepts } from './review-bank'
import { loadTopicLearningState } from './next-activity-server'
import { previewReviewSize } from './review-session'
import { shortSessionPlan, sizeShortSession, type ShortSessionPlan, type ShortSessionState } from './short-session'

/**
 * The topic the plan is on now: the first learn or quiz item left today, else the first learn item of the plan. Null when the
 * plan has none (everything is learned, or the course has no plan yet).
 */
export function currentPlanTopicId(plan: Plan): string | null {
  const open = todayItems(plan).find((item) => !item.done && item.topicId && (item.kind === 'learn' || item.kind === 'quiz'))
  if (open?.topicId) return open.topicId
  for (const day of plan.days) {
    const learn = day.items.find((item) => !item.done && item.kind === 'learn' && item.topicId)
    if (learn?.topicId) return learn.topicId
  }
  return null
}

/** What `shortSessionPlan` needs for one course: what is due, the plan's current topic with its stages, and whether the AI is up. */
export async function loadShortSessionState(userId: string, courseId: string, timeZone: string, now: Date = new Date()): Promise<ShortSessionState | null> {
  const data = await getPlanData(userId, courseId, timeZone, now)
  if (!data) return null
  const [due, status] = await Promise.all([countDueConcepts(userId, courseId, timeZone, now), getAiStatus(userId)])
  const topicId = currentPlanTopicId(data.plan)
  let currentTopic: ShortSessionState['currentTopic'] = null
  if (topicId) {
    // The same stages the next-activity cascade reads, so Home and the topic page agree on "read, not yet recalled".
    const state = await loadTopicLearningState({ userId, topicId, now, timeZone })
    currentTopic = { id: topicId, readAt: state.readAt, recallAt: state.recallAt }
  }
  return { courseId, due, currentTopic, ai: blockedCode(status) ? 'down' : 'up' }
}

/** The short session on offer for a course, or null when there is nothing to offer. */
export async function shortSessionOffer(userId: string, courseId: string, timeZone: string): Promise<{ plan: ShortSessionPlan; currentTopicId: string | null } | null> {
  const state = await loadShortSessionState(userId, courseId, timeZone)
  if (!state) return null
  const plan = shortSessionPlan(state)
  if (!plan) return null
  const currentTopicId = state.currentTopic?.id ?? null
  if (plan.kind === 'recall') return { plan, currentTopicId }
  // The card says how many questions the session will really have, worked out the way the session is made (the route starts it
  // with the same limit and topics): concepts due are not the same as questions ready, and a short format leaves some out.
  const size = await previewReviewSize({
    userId,
    projectId: courseId,
    timeZone,
    limit: plan.limit,
    ...(plan.kind === 'mini_quiz' ? { includeNotDue: true, topicIds: [currentTopicId ?? ''] } : {}),
  })
  if (size.ready + size.toWrite === 0) return null
  return { plan: sizeShortSession(plan, size, state.ai), currentTopicId }
}

/** The topics of a course the student chose a quick pass for. */
export async function quickPassTopicIds(userId: string, courseId: string): Promise<string[]> {
  const rows = await prisma.topicProgress.findMany({
    where: { userId, triage: 'quick', topic: { projectId: courseId, project: { userId } } },
    select: { topicId: true },
  })
  return rows.map((row) => row.topicId)
}

/**
 * Sets or clears the quick pass on a topic (spec 18.8): `TopicProgress.triage = 'quick'`, with the time it was chosen. Clearing it
 * ("Undo quick pass") puts the full block back. Only the student's own topic: anything else is not found.
 */
export async function setQuickPass(userId: string, topicId: string, quick: boolean): Promise<'ok' | 'not_found'> {
  const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId } }, select: { id: true } })
  if (!topic) return 'not_found'
  const data = quick ? { triage: 'quick', triageAt: new Date() } : { triage: null, triageAt: null }
  await prisma.topicProgress.upsert({
    where: { topicId_userId: { topicId, userId } },
    create: { topicId, userId, ...data },
    update: data,
  })
  return 'ok'
}
