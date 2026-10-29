/**
 * Which topics a voice sprint covers. This is the selection `buildSprintQuestionSet` makes in
 * src/lib/voice/drill-pack.ts, kept here as pure code so the sprint page can say which topics
 * the coach will ask about. If the backend rule changes, change this with it.
 *
 * Rule: score = best quiz score (0 with no quiz yet); a topic with any of notes, examples or
 * quiz not completed counts 10 points lower; the lowest three win, ties keep the input order.
 */

export type RankableTopic = {
  id: string
  name: string
  progress: {
    quizScore: number | null
    quizCompleted: boolean
    notesCompleted: boolean
    examplesCompleted: boolean
  } | null
}

export const SPRINT_TOPIC_COUNT = 3

export function rankWeakestTopics<T extends RankableTopic>(topics: T[], limit = SPRINT_TOPIC_COUNT): T[] {
  return topics
    .map((topic, position) => {
      const progress = topic.progress
      const score = progress?.quizScore ?? 0
      const incomplete = !progress?.quizCompleted || !progress?.notesCompleted || !progress?.examplesCompleted
      return { topic, position, priority: incomplete ? score - 10 : score }
    })
    .sort((a, b) => a.priority - b.priority || a.position - b.position)
    .slice(0, limit)
    .map((entry) => entry.topic)
}

/**
 * Whether the ranking has anything to go on: at least one topic has a quiz score. Before that,
 * every topic ties and the sprint takes the first ones in input order, so they are not "weakest".
 */
export function hasStudyData(topics: RankableTopic[]): boolean {
  return topics.some((topic) => topic.progress?.quizScore != null)
}

/**
 * "Covers your 3 weakest topics: A, B and C." once a topic has a quiz score; before that
 * "Covers 3 of your topics: A, B and C. After your first quiz it picks your weakest."
 * The count follows the list.
 */
export function describeSprintTopics(topics: { name: string }[], studied: boolean): string {
  const names = topics.map((topic) => topic.name)
  if (names.length === 0) return ''
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  if (!studied) {
    const some = names.length === 1 ? 'one of your topics' : `${names.length} of your topics`
    return `Covers ${some}: ${list}. After your first quiz it picks your weakest.`
  }
  const what = names.length === 1 ? 'your weakest topic' : `your ${names.length} weakest topics`
  return `Covers ${what}: ${list}.`
}
