import type { NavCourse } from '@/server/queries/courses'

/**
 * The course pages that have nothing to show until the topics are confirmed (Plan, the Topics list,
 * Ask, Mock exams, Review, Map). During setup the sidebar and the phone navigation do not list them
 * as dead links: they show Overview (the setup steps), Materials and the course settings, and one
 * compact setup progress block (setup-progress.tsx) that says where the student is and what opens next.
 */
const GATED_UNTIL_READY = new Set(['plan', 'topics', 'ask', 'exams', 'review', 'map'])

/** The one short note shown in place of the pages that are not ready. */
export const NOT_READY_REASON = 'Plan, Topics, Ask, Review and the other study pages open once you confirm your topics.'

/** True when this section of the course is not ready yet. `ready` is `NavCourse.ready`. */
export const isSectionNotReady = (key: string, course: Pick<NavCourse, 'ready'>): boolean =>
  !course.ready && GATED_UNTIL_READY.has(key)

/** The course is still on steps 1 or 2 of setup: the navigation is the compact setup one. */
export const inFirstSetup = (course: Pick<NavCourse, 'ready'>): boolean => !course.ready
