/**
 * The names of the three things a student sees side by side that measure different things. Every screen uses these names, so
 * "Strong" or "Learning" always means a topic and "Solid" or "Shaky" always means an idea.
 */

/** How well a whole topic is known: Strong / Getting there / Learning / Not started (lib/mastery.ts). */
export const TOPIC_PROGRESS_NAME = 'Topic progress'

/** How well one idea inside a topic is known: Solid / Shaky / New and the rest (lib/map/copy.ts). */
export const IDEA_RECALL_NAME = 'Idea recall'

/** The result of one quiz. */
export const QUIZ_SCORE_NAME = 'Quiz score'

/** One paragraph for the places that show more than one of the three together. */
export const PROGRESS_GLOSSARY =
  'Topic progress is how well you know a whole topic. Idea recall is how well you know one idea inside it. A quiz score is how you did on one quiz.'
