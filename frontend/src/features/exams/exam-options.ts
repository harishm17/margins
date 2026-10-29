/** The choices on the new mock exam form, and the rules that turn them into a request. */
import { DEFAULT_DURATION_MINUTES, DEFAULT_TOTAL_QUESTIONS } from '@/lib/exams/form-defaults'
import { LEARNING_BELOW, STRONG_FROM } from '@/lib/mastery'

export { DEFAULT_DURATION_MINUTES, DEFAULT_TOTAL_QUESTIONS, QUESTION_COUNTS, TIME_LIMITS, examDefaultsFromParams, questionsForMinutes } from '@/lib/exams/form-defaults'
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

export type QuestionTypeDistribution = { multiple_choice: number; short_answer: number; numerical: number }

export const QUESTION_MIXES = {
  balanced: { label: 'Balanced', distribution: { multiple_choice: 60, short_answer: 30, numerical: 10 } },
  concepts: { label: 'More concepts', distribution: { multiple_choice: 40, short_answer: 50, numerical: 10 } },
  calculation: { label: 'More calculation', distribution: { multiple_choice: 40, short_answer: 20, numerical: 40 } },
} as const satisfies Record<string, { label: string; distribution: QuestionTypeDistribution }>

export type QuestionMix = keyof typeof QUESTION_MIXES

export const DEFAULT_EXAM_CONFIG = {
  totalQuestions: DEFAULT_TOTAL_QUESTIONS,
  durationMinutes: DEFAULT_DURATION_MINUTES,
  difficultyLevel: 'medium' as Difficulty,
  mix: 'balanced' as QuestionMix,
}

type TopicSignal = { id: string; mastery: number | null; dueAt: string | null }

/**
 * Topics worth testing: those due for review or not yet Strong (including ones with no signal).
 * When every topic is already strong, all of them.
 */
export function preselectTopics(topics: readonly TopicSignal[], now: number): string[] {
  const wanted = topics.filter(
    (topic) =>
      topic.mastery === null ||
      topic.mastery < STRONG_FROM ||
      (topic.dueAt !== null && new Date(topic.dueAt).getTime() <= now)
  )
  return (wanted.length > 0 ? wanted : topics).map((topic) => topic.id)
}

/** True when a topic's mastery is low enough to show the warning tone. */
export const isLowMastery = (mastery: number | null): boolean => mastery !== null && mastery < LEARNING_BELOW

const DIFFICULTY_LABELS: Record<string, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }
export const difficultyLabel = (value: string): string => DIFFICULTY_LABELS[value] ?? value

/** "20 questions, 60 min, medium". */
export function examSummary(facts: { questionCount: number; durationMinutes: number; difficulty: string }): string {
  const questions = `${facts.questionCount} ${facts.questionCount === 1 ? 'question' : 'questions'}`
  return `${questions}, ${formatMinutes(facts.durationMinutes)}, ${facts.difficulty.toLowerCase()}`
}

/** "45 min", "1 hr", "1 hr 30 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

export { formatScore } from '@/lib/format'
