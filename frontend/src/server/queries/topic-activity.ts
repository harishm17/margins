import { loadTopicLearningState, resolveTopicActivity } from '@/lib/learning/next-activity-server'
import { pathStepFor } from '@/features/topic/activity-copy'
import { nextStepWords, pathGlyphs, pathSteps, type PathGlyph } from '@/features/topic/path-steps'
import type { NextStep } from '@/lib/learning/next-step'
import { overlayActivity, wantsTopicActivity, type ActivityOverlay } from '@/features/topic/step-activity'

/**
 * A next step whose item is a topic, worded by that topic's next activity (spec §8.1): the reason is the
 * activity's sentence, the button its verb, the address where it opens. Any other step is returned as it is.
 * The course overview and the home Continue card both go through here, and the topic page uses the same
 * `resolveTopicActivity`, so all three agree.
 */
export async function withTopicActivity(
  userId: string,
  courseId: string,
  step: NextStep,
  topics: { id: string; unitId: string | null; confirmed: boolean }[],
  listConfirmed: boolean
): Promise<NextStep> {
  const topicId = wantsTopicActivity(step)
  if (!topicId || !topics.some((item) => item.id === topicId)) return step
  return overlayActivity(step, await topicActivity(userId, courseId, topicId, topics, listConfirmed))
}

type TopicRef = { id: string; unitId: string | null; confirmed: boolean }

/** The one place a topic's next activity (with its address) is worked out for a screen; every screen that names it comes here. */
export async function topicActivity(userId: string, courseId: string, topicId: string, topics: TopicRef[], listConfirmed: boolean): Promise<ActivityOverlay> {
  const { kind, reason, href } = await resolveTopicActivity({ userId, courseId, topicId, topics, listConfirmed })
  return { kind, reason, href }
}

export type TopicPathSummary = { glyphs: PathGlyph[]; nextWords: string }

/**
 * Each topic's path for the Topics list: the steps it offers, which are done, and what is next in words. Every topic is read
 * with the loader and the cascade the topic page uses, and its steps are decided by the same `pathSteps`, so a row names the
 * step that the topic's own path tags as Next.
 */
export async function topicPaths(
  userId: string,
  courseId: string,
  rows: { id: string; progress: { notes: boolean; quizScore: number | null } }[],
  topics: TopicRef[],
  listConfirmed: boolean
): Promise<Record<string, TopicPathSummary>> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const state = await loadTopicLearningState({ userId, topicId: row.id })
      const next = await resolveTopicActivity({ userId, courseId, topicId: row.id, topics, listConfirmed, state })
      const steps = pathSteps({
        hasConcepts: state.concepts.length > 0,
        warmupReady: state.warmupReady,
        warmupDone: state.warmupAt !== null,
        readDone: state.readAt !== null,
        preparingConcepts: false,
      })
      const glyphs = pathGlyphs({
        steps,
        done: {
          warmup: state.warmupAt !== null,
          read: state.readAt !== null || row.progress.notes,
          recall: state.recallAt !== null,
          practice: state.practiceDone,
          quiz: row.progress.quizScore !== null,
        },
        nextStep: pathStepFor(next.kind),
      })
      return [row.id, { glyphs, nextWords: nextStepWords(next.kind) }] as const
    })
  )
  return Object.fromEntries(entries)
}

/** The next activity of each of these topics, for the plan page (see `topicActivity`). */
export async function topicActivities(
  userId: string,
  courseId: string,
  topicIds: string[],
  topics: TopicRef[],
  listConfirmed: boolean
): Promise<Record<string, ActivityOverlay>> {
  const known = [...new Set(topicIds)].filter((id) => topics.some((item) => item.id === id))
  const entries = await Promise.all(known.map(async (id) => [id, await topicActivity(userId, courseId, id, topics, listConfirmed)] as const))
  return Object.fromEntries(entries)
}
