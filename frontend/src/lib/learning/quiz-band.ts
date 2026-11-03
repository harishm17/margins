import { loadTopicLearningState } from './next-activity-server'
import { quizDifficultyFor, topicBand, type Band } from './level'
import { studentTimeZone } from './student-time-zone'

/**
 * The difficulty of a set written on demand (New questions, Fix it now, Harder set) comes from the topic's band
 * (spec 5.7, 18.6). `base` is the plan the fresh-review route already builds (count, focus, concepts, prerequisite);
 * only its difficulty is replaced. A harder set is hard whatever the band. A topic with no concepts has no band, so
 * the plan's own difficulty (from the topic's mastery) stays.
 */
export function onDemandQuizPreferences<T extends { difficulty_level: string }>(base: T, band: Band | null, force?: 'hard'): T {
  if (force) return { ...base, difficulty_level: force }
  return band === null ? base : { ...base, difficulty_level: quizDifficultyFor(band) }
}

/** The topic's support band for this student, or null for a topic whose concepts are not in use yet. */
export async function topicBandOf(userId: string, topicId: string): Promise<Band | null> {
  const state = await loadTopicLearningState({ userId, topicId, timeZone: await studentTimeZone() })
  if (state.concepts.length === 0) return null
  return topicBand(state.concepts.map((concept) => ({ band: concept.band, solid: concept.label === 'solid' })))
}
