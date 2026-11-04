/**
 * The three steps of a course, in one place: Home's "How a course goes" (welcome.tsx) and the course's own
 * stepper (setup-guide.tsx) read the same titles and the same count, so the two never disagree. The exam date
 * and daily time are asked inside the last step, so they are part of it, not a step of their own.
 */
export const COURSE_STAGES = [
  {
    title: 'Add your materials',
    time: 'A couple of minutes',
    text: 'Lecture notes or slides, book chapters and past exams (mark those as past exams, so Margins can match their style). Margins reads them to find your topics.',
  },
  {
    title: 'Check the topics',
    time: 'About a minute',
    text: 'Margins finds the topics in your files. Rename, merge or remove any, then confirm the list.',
  },
  {
    title: 'Start studying',
    time: 'Your daily time',
    text: 'Set your exam date and daily time for a day-by-day plan that ends at your exam. Reviews and mock exams come before it.',
  },
] as const

/**
 * What a topic holds, said once the course exists (the setup page's "What each step involves"), not on Home's three-stage
 * overview, where it made the third stage far longer than the first two.
 */
export const TOPIC_STEPS_TEXT =
  'Every topic has five steps: Warm-up (try a few questions first), Read (your own pages), Recall (with the book closed), Practice and a Quiz.'

/** The line under a course's name while it is being set up, and the heading of the same list on Home. */
export const COURSE_STAGES_SUMMARY = 'Three steps and you’re ready to study.'
