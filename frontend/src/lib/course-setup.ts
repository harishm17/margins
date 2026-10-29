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
 * The topic list counts as confirmed once the student pressed Confirm (the project status is active
 * or completed) and at least one topic is confirmed. A topic added by hand is confirmed when it is
 * made, but adding one does not confirm the list: Confirm does. Once confirmed, a course stays
 * active: when topic finding adds new topics, they wait as "new topics to review" (`topics.unconfirmed`)
 * while the plan, Up next, the sidebar and exams keep using the confirmed topics, and Confirm adds
 * the new ones. A course with no confirmed topic left (all deleted, or only new ones) is in step 2.
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
  /** Unconfirmed topics found after the student had already confirmed the list (or some found ones). */
  newSinceConfirm: number
  /** The student confirmed the list and some confirmed topics remain: steps 1 and 2 are done and the plan can be built. New unconfirmed topics do not undo it. */
  listConfirmed: boolean
  extraction: ExtractionOutcome
}

export type CourseSetup =
  | { mode: 'active'; step: null; label: null; topics: TopicListState }
  | { mode: 'setup'; step: 1 | 2 | 3; label: string; topics: TopicListState }

const CONFIRMED_STATUSES = new Set(['active', 'completed'])

export function deriveSetup(input: CourseSetupInput): CourseSetup {
  const unconfirmed = Math.max(0, input.topicCount - input.confirmedTopicCount)
  const listConfirmed = CONFIRMED_STATUSES.has(input.status) && input.confirmedTopicCount > 0
  const topics: TopicListState = {
    total: input.topicCount,
    confirmed: input.confirmedTopicCount,
    unconfirmed,
    extracted: input.extractedTopicCount,
    manual: Math.max(0, input.topicCount - input.extractedTopicCount),
    newSinceConfirm: listConfirmed || input.confirmedExtractedTopicCount > 0 ? unconfirmed : 0,
    listConfirmed,
    extraction: input.extraction,
  }

  // Files are what topics are found in and what study content is written from. Deleting a file keeps
  // the topics, the content and the progress (only its sources go), so a course that has content
  // stays set up without files; one with nothing written yet is back to step 1, confirmed or not.
  if (input.materialCount === 0 && input.contentBlockCount === 0) {
    return { mode: 'setup', step: 1, label: 'Upload materials', topics }
  }
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

/**
 * Steps 1 and 2 are done (step 3 or active): the plan, the next step and the study-plan API use the
 * course. Not the same as `topics.listConfirmed`, which is only about the list (the Topics page and the
 * editor's Confirm read that): a confirmed list with no files and nothing written is not ready.
 */
export const readyToStudy = (setup: CourseSetup): boolean => setup.mode === 'active' || setup.step === 3

/**
 * Topics waiting for the student: the sidebar's dot on Topics. Step 2 with topics, or a confirmed
 * course with new unconfirmed topics.
 */
export const needsTopicReview = (setup: CourseSetup): boolean =>
  setup.topics.listConfirmed
    ? setup.topics.unconfirmed > 0
    : setup.mode === 'setup' && setup.step === 2 && setup.topics.total > 0

/** "3 new topics to review": shown on a confirmed course while found topics wait for the student. */
export const newTopicsLabel = (topics: TopicListState): string | null =>
  topics.listConfirmed && topics.unconfirmed > 0 ? `${pluralize(topics.unconfirmed, 'new topic')} to review` : null

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
