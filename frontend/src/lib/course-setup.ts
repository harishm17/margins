import { pluralize } from './format'

/**
 * Where a course is in setup: the one definition every screen reads (Home, the overview, the
 * sidebar, the Topics page, the Plan, the next step and the health API). Nothing else decides
 * "setup is done" from `Topic.userConfirmed` on its own.
 *
 *   step 1  add materials
 *   step 2  check the topics (also while topics are still being found)
 *   step 3  start studying (content is written when a topic is opened)
 *
 * The topic list counts as confirmed only once the student pressed Confirm (the project status is
 * active or completed) and every topic is confirmed. A topic added by hand is confirmed when it is
 * made, but adding one does not confirm the list: Confirm does. When topic finding adds new topics to
 * a confirmed course, the planner sets the status back to topics_pending and the course is in step 2
 * again until the student confirms the new ones.
 */

/** The latest topic-finding job of the course. */
export type ExtractionOutcome = 'none' | 'running' | 'failed' | 'done'

export type CourseSetupInput = {
  status: string
  materialCount: number
  topicCount: number
  confirmedTopicCount: number
  /** Topics found in the files (they have sources); the others were added by hand. */
  extractedTopicCount: number
  /** Extracted topics the student has already confirmed. */
  confirmedExtractedTopicCount: number
  contentBlockCount: number
  extraction: ExtractionOutcome
}

/** The topic list and where it came from, for the copy ("We found 4 topics", "You added 2"). */
export type TopicListState = {
  total: number
  confirmed: number
  /** Not confirmed yet: always topics found in the files. */
  unconfirmed: number
  /** Found in the files. */
  extracted: number
  /** Added by hand. */
  manual: number
  /** Unconfirmed topics found after the student had already confirmed some found ones. */
  newSinceConfirm: number
  /** The student confirmed the list: steps 1 and 2 are done and the plan can be built. */
  listConfirmed: boolean
  extraction: ExtractionOutcome
}

export type CourseSetup =
  | { mode: 'active'; step: null; label: null; topics: TopicListState }
  | { mode: 'setup'; step: 1 | 2 | 3; label: string; topics: TopicListState }

const CONFIRMED_STATUSES = new Set(['active', 'completed'])

export function deriveSetup(input: CourseSetupInput): CourseSetup {
  const unconfirmed = Math.max(0, input.topicCount - input.confirmedTopicCount)
  const listConfirmed =
    CONFIRMED_STATUSES.has(input.status) && input.topicCount > 0 && unconfirmed === 0
  const topics: TopicListState = {
    total: input.topicCount,
    confirmed: input.confirmedTopicCount,
    unconfirmed,
    extracted: input.extractedTopicCount,
    manual: Math.max(0, input.topicCount - input.extractedTopicCount),
    newSinceConfirm: input.confirmedExtractedTopicCount > 0 ? unconfirmed : 0,
    listConfirmed,
    extraction: input.extraction,
  }

  if (input.materialCount === 0) return { mode: 'setup', step: 1, label: 'Upload materials', topics }
  if (!listConfirmed) return { mode: 'setup', step: 2, label: stepTwoLabel(topics), topics }
  if (input.contentBlockCount === 0) return { mode: 'setup', step: 3, label: 'Start studying', topics }
  return { mode: 'active', step: null, label: null, topics }
}

function stepTwoLabel(topics: TopicListState): string {
  if (topics.total > 0) return topics.unconfirmed > 0 ? 'Review topics' : 'Confirm topics'
  if (topics.extraction === 'failed') return 'Add topics'
  if (topics.extraction === 'done') return 'Find topics'
  return 'Finding topics'
}

/** The student confirmed the topic list (steps 1 and 2 are done): the plan, Today and reviews can use it. */
export const topicsConfirmed = (setup: CourseSetup): boolean => setup.topics.listConfirmed

/** Topics exist and the list is waiting for the student: the sidebar's dot on Topics. */
export const needsTopicReview = (setup: CourseSetup): boolean =>
  !setup.topics.listConfirmed && setup.topics.total > 0

/**
 * Where the topic list came from, in one sentence: "We found 5 topics in your files." Found only
 * counts topics that came from the files; hand-added ones read as added.
 */
export function topicOriginSentence(topics: TopicListState): string {
  if (topics.newSinceConfirm > 0) return `We found ${pluralize(topics.newSinceConfirm, 'new topic')} in your files.`
  if (topics.extracted > 0 && topics.manual > 0) {
    return `We found ${pluralize(topics.extracted, 'topic')} in your files and you added ${pluralize(topics.manual, 'topic')}.`
  }
  if (topics.extracted > 0) return `We found ${pluralize(topics.extracted, 'topic')} in your files.`
  if (topics.manual > 0) return `You added ${pluralize(topics.manual, 'topic')}.`
  return ''
}
