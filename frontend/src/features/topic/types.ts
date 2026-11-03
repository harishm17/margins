/** Shared by the topic page's server read model and its client views. */

export type ViewId = 'warmup' | 'read' | 'recall' | 'practice' | 'quiz' | 'examples' | 'explainer' | 'voice'

/** The path, in order (spec §5): the steps a topic is learned in. */
export const PATH_VIEWS = ['warmup', 'read', 'recall', 'practice', 'quiz'] as const satisfies readonly ViewId[]

/** Tools, always open: worked examples, the explainer (gated until recall) and voice practice. */
export const TOOL_VIEWS = ['examples', 'explainer', 'voice'] as const satisfies readonly ViewId[]

export type PathView = (typeof PATH_VIEWS)[number]
export type ToolView = (typeof TOOL_VIEWS)[number]

export const VIEW_IDS: ViewId[] = [...PATH_VIEWS, ...TOOL_VIEWS]

export const VIEW_LABELS: Record<ViewId, string> = {
  warmup: 'Warm-up',
  read: 'Read',
  recall: 'Recall',
  practice: 'Practice',
  quiz: 'Quiz',
  examples: 'Worked examples',
  explainer: 'Explainer',
  voice: 'Voice practice',
}

/** Shorter names for a phone, where five steps share 358px. */
export const SHORT_LABELS: Record<ViewId, string> = {
  warmup: 'Warm-up',
  read: 'Read',
  recall: 'Recall',
  practice: 'Practice',
  quiz: 'Quiz',
  examples: 'Examples',
  explainer: 'Explainer',
  voice: 'Voice',
}

/** The four kinds of generated content; the voice view has none. */
export type ContentKind = 'notes' | 'examples' | 'practice' | 'quiz'

export const CONTENT_KINDS: ContentKind[] = ['notes', 'examples', 'practice', 'quiz']

export const CONTENT_TYPE_BY_KIND: Record<ContentKind, string> = {
  notes: 'section_notes',
  examples: 'solved_examples',
  practice: 'interactive_examples',
  quiz: 'topic_quiz',
}

export const KIND_BY_CONTENT_TYPE: Record<string, ContentKind> = {
  section_notes: 'notes',
  solved_examples: 'examples',
  interactive_examples: 'practice',
  topic_quiz: 'quiz',
}

/**
 * Jobs that prepare a topic before its notes: the concepts and the warm-up. They run ahead of the
 * notes in the same chain, so the page follows them as the notes being prepared; a failure of one
 * is not a failure of the notes (the AI service goes on to write them).
 */
export const PREPARATION_TYPES: string[] = ['concepts', 'warmup']

export const isViewId = (value: unknown): value is ViewId =>
  typeof value === 'string' && (VIEW_IDS as string[]).includes(value)

/**
 * The view a ?view= names. "notes" was the first view before the path existed (bookmarks and old links
 * still carry it); it is the Read step now. Null for anything else.
 */
export function parseView(value: unknown): ViewId | null {
  if (value === 'notes') return 'read'
  return isViewId(value) ? value : null
}

export type TopicCitation = {
  filename: string
  /** "4", "4-5", or null when the file has no pages (a Word document, say). */
  pages: string | null
  materialId: string | null
  page: number | null
}

import type { SourceRef } from '@/lib/topics/sources'

export type { SourceRef }

export type NotesContent = {
  text: string
  citations: TopicCitation[]
  updatedAt: string
}

export type SolvedStep = {
  number: number
  description: string
  work: string
  explanation: string
  /** The concepts the step is about; the example's when the step has none of its own. Empty for older content. */
  conceptIds: string[]
}

export type SolvedExample = {
  title: string
  problem: string
  steps: SolvedStep[]
  finalAnswer: string
  keyConcepts: string[]
  difficulty: 'easy' | 'medium' | 'hard' | null
  /** The concepts the example works with, primary first. Empty for content written before concepts (self-grades then fall back to names). */
  conceptIds: string[]
  /** Where in the files the example is based on (empty for content written before sources existed). */
  sources: SourceRef[]
}

export type ExamplesContent = { items: SolvedExample[]; updatedAt: string }

export type PracticeStep = {
  number: number
  question: string
  /** The connect hint; for new content it is `hints[1]`, for older content the only hint. */
  hint: string
  /** Locate, connect, structure (spec §5.6). Older content has only the connect slot filled. */
  hints: [string, string, string]
  /** The concepts the step practises; the problem's when the step has none of its own. */
  conceptIds: string[]
  answerType: 'numeric' | 'text' | 'multiple_choice'
  /** multiple_choice steps: 2 to 5 options to show. Empty for older content (the options are then in the question text). */
  options: { id: string; text: string }[]
  correctAnswer: string
  acceptableAnswers: string[]
  /** numeric steps: the accepted absolute difference; null means within 1%. */
  tolerance: number | null
  explanation: string
  feedbackCorrect: string
  feedbackIncorrect: string
}

export type PracticeProblem = {
  title: string
  problem: string
  steps: PracticeStep[]
  keyConcepts: string[]
  conceptIds: string[]
  difficulty: string | null
  minutes: number | null
  sources: SourceRef[]
}

export type PracticeContent = { items: PracticeProblem[]; updatedAt: string }
