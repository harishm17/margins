import type { CourseSetup } from '@/lib/course-setup'
import type { NextStep } from './next-step'
import { REVIEW_MINUTES, todayItems, type Plan, type PlanItem } from './plan'

/**
 * The shape GET /api/projects/[projectId]/next-actions has always returned. The actions are now
 * today's items of the study plan (lib/learning/plan.ts), or the next setup step while the course is
 * still being set up.
 */
export type NextAction = {
  id: string
  type:
    | 'upload_materials'
    | 'extract_topics'
    | 'confirm_topics'
    | 'study_topic'
    | 'review_topic'
    | 'take_quiz'
    | 'take_exam'
  topicId: string | null
  title: string
  reason: string
  priority: number
  etaMinutes: number
}

const TYPE_BY_KIND: Record<PlanItem['kind'], NextAction['type']> = {
  learn: 'study_topic',
  quiz: 'take_quiz',
  review: 'review_topic',
  mixed: 'take_exam',
  unit_mock: 'take_exam',
  full_mock: 'take_exam',
}

/** What to do next while the course is being set up, or null once it is set up. */
export function setupNextAction(courseId: string, setup: Omit<CourseSetup, 'topics'>, topicCount: number): NextAction | null {
  if (setup.mode === 'active') return null
  if (setup.step === 1) {
    return {
      id: `${courseId}-upload-materials`,
      type: 'upload_materials',
      topicId: null,
      title: 'Upload your first study material',
      reason: 'Add at least one supported study file to begin.',
      priority: 0,
      etaMinutes: 5,
    }
  }
  if (setup.step === 2) {
    return topicCount === 0
      ? {
          id: `${courseId}-extract-topics`,
          type: 'extract_topics',
          topicId: null,
          title: 'Find the topics in your files',
          reason: 'Margins reads your materials and suggests a topic list.',
          priority: 0,
          etaMinutes: 8,
        }
      : {
          id: `${courseId}-confirm-topics`,
          type: 'confirm_topics',
          topicId: null,
          title: 'Review and confirm topics',
          reason: 'Check the list before you start studying.',
          priority: 0,
          etaMinutes: 6,
        }
  }
  return null
}

/** Today's items that are still to do, in the order to do them. */
export function nextActionsFromPlan(plan: Plan): NextAction[] {
  return todayItems(plan)
    .filter((item) => !item.done)
    .map((item, index) => ({
      id: item.id,
      type: TYPE_BY_KIND[item.kind],
      topicId: item.topicId,
      title: item.title,
      reason: item.note ?? '',
      priority: index,
      etaMinutes: item.minutes,
    }))
}

/**
 * The actions the next-actions API returns, taken from the same next step the screens show
 * (lib/learning/next-step.ts): today's plan items, or the review that is due when today's plan is
 * done. Nothing when there is nothing to do.
 */
export function nextActionsFromStep(step: NextStep, plan: Plan): NextAction[] {
  if (step.kind === 'work') return nextActionsFromPlan(plan)
  if (step.kind === 'reviews_due' && step.action?.topicId) {
    return [
      {
        id: `review:${step.action.topicId}`,
        type: 'review_topic',
        topicId: step.action.topicId,
        title: step.title,
        reason: step.reason,
        priority: 0,
        etaMinutes: REVIEW_MINUTES,
      },
    ]
  }
  return []
}
