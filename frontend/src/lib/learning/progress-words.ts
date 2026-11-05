import type { ConceptLabel } from './concept-mastery'

/**
 * The one glossary of progress words. Three different things are measured on a course's screens, and each has
 * one name and one set of band words, so a word never means two things:
 *
 *   Topic progress  how well you know a whole topic (Topics list, Home, Overview, a topic's header)
 *   Idea recall     how well one idea inside a topic is remembered (the Map, the idea lists)
 *   Quiz score      how you did on one quiz
 *
 * The topic bands are the only place "Strong" and "Learning" are written; the idea bands are the only place
 * "Solid" and "Shaky" are. `lib/mastery.ts` reads the topic words from here, `lib/map/copy.ts` the idea words.
 */

export const PROGRESS_MEASURE = {
  topic: 'Topic progress',
  idea: 'Idea recall',
  quiz: 'Quiz score',
} as const

/** The four bands of topic progress, keyed like `MasteryLevel` in lib/mastery.ts. */
export const TOPIC_PROGRESS_WORDS = {
  none: 'Not started',
  learning: 'Learning',
  getting: 'Getting there',
  strong: 'Strong',
} as const

/** The bands of idea recall, keyed by the concept label the map computes. */
export const IDEA_RECALL_WORDS: Record<ConceptLabel, string> = {
  not_started: 'Not started',
  inferred: 'Inferred',
  shaky: 'Shaky',
  getting_there: 'Getting there',
  solid: 'Solid',
  fading: 'Fading',
}

/** One paragraph per measure, for the "What these mean" disclosure. */
export const PROGRESS_GLOSSARY = {
  topic: `${PROGRESS_MEASURE.topic} is how well you know a whole topic, from your recent answers and how long ago they were. It is the average of the topic's ideas.`,
  idea: `${PROGRESS_MEASURE.idea} is how well you remember one idea inside a topic. Ideas are Solid, Getting there, Shaky or Fading, or Not started before you have tried them.`,
  quiz: `${PROGRESS_MEASURE.quiz} is how you did on one quiz. It counts toward topic progress along with your later reviews, but it is not the progress itself.`,
} as const
