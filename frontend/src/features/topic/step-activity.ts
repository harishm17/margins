import type { ActivityKind } from '@/lib/learning/next-activity'
import type { NextStep } from '@/lib/learning/next-step'
import { activityVerb } from './activity-copy'

/**
 * Where a topic is the next step (spec §8.1, last paragraph): the course overview's Up next and the home
 * Continue card show the topic's next activity in place of the plan's wording. Only a plan item about
 * learning or first quizzing a topic is replaced; reviews, exams, setup and a finished day keep theirs.
 */

/** The topic whose next activity should speak for this step, or null when the step keeps the plan's wording. */
export function wantsTopicActivity(step: NextStep): string | null {
  const action = step.action
  if (step.kind !== 'work' || !action?.topicId) return null
  return action.itemKind === 'learn' || action.itemKind === 'quiz' ? action.topicId : null
}

export type ActivityOverlay = { kind: ActivityKind; reason: string; href: string }

/** The step with the activity's reason as its sentence and its verb and address on the button. */
export function overlayActivity(step: NextStep, activity: ActivityOverlay): NextStep {
  if (wantsTopicActivity(step) === null || !step.action) return step
  return {
    ...step,
    reason: activity.reason,
    action: { ...step.action, verb: activityVerb(activity.kind), href: activity.href },
  }
}

/**
 * A plan row worded by its topic's next activity, the way Home and the overview word the same step (spec §8.1): the
 * activity's sentence, verb and address replace the plan's. Only a topic's learn or first-quiz row that is still to do
 * is replaced; its title, minutes and part stay.
 */
export function overlayPlanItem<T extends { kind: string; done: boolean; reason: string; verb: string; href: string }>(item: T, activity: ActivityOverlay | undefined): T {
  if (!activity || item.done || (item.kind !== 'learn' && item.kind !== 'quiz')) return item
  return { ...item, reason: activity.reason, verb: activityVerb(activity.kind), href: activity.href }
}
