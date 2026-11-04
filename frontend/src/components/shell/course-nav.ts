import type { NavCourse } from '@/server/queries/courses'

/**
 * The course pages that have nothing to show until the topics are confirmed (Plan, the Topics list,
 * Ask, Mock exams, Review, Map). During setup the sidebar and the phone navigation show them as not
 * ready, with the reason, instead of leading to an empty page. Overview (the setup steps) and
 * Materials stay open.
 */
const GATED_UNTIL_READY = new Set(['plan', 'topics', 'ask', 'exams', 'review', 'map'])

/** The one short reason shown for every page that is not ready. */
export const NOT_READY_REASON = 'Opens once you confirm your topics.'

/** True when this section of the course is not ready yet. `ready` is `NavCourse.ready`. */
export const isSectionNotReady = (key: string, course: Pick<NavCourse, 'ready'>): boolean =>
  !course.ready && GATED_UNTIL_READY.has(key)
