import { formatDueLabel, formatRelative, pluralize } from '@/lib/format'
import { dueBoundary, isReviewDue } from '@/lib/learning/next-step'
import type { MasteryCounts } from '@/lib/mastery'

/** "12 topics, 4 strong, 2 due for review, exam in 3 days". Parts that are zero or unknown are left out. */
export function courseSummary(topicCount: number, counts: MasteryCounts, dueCount: number, exam?: string | null): string {
  const parts = [pluralize(topicCount, 'topic')]
  if (counts.strong > 0) parts.push(`${counts.strong} strong`)
  if (dueCount > 0) parts.push(`${dueCount} due for review`)
  if (exam) parts.push(exam.charAt(0).toLowerCase() + exam.slice(1))
  return parts.join(', ')
}

/** Files the uploader accepts, with the words used when one is refused. */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.doc'] as const
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',')

export type FileProblem = 'type' | 'size' | 'empty'

/** Why a file cannot be uploaded, or null when it can. The server checks again. */
export function fileProblem(file: { name: string; size: number }, maxUploadMb: number): FileProblem | null {
  const dot = file.name.lastIndexOf('.')
  const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase()
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) return 'type'
  if (file.size === 0) return 'empty'
  if (file.size > maxUploadMb * 1024 * 1024) return 'size'
  return null
}

export function problemMessage(problem: FileProblem, maxUploadMb: number): string {
  if (problem === 'type') return 'Use a PDF, DOCX, PPTX or DOC file.'
  if (problem === 'empty') return 'This file is empty.'
  return `Files can be up to ${maxUploadMb} MB.`
}

/** The upload picker's words ("Use these as:"). They only set a file's starting role (lib/materials/role.ts). */
export const CATEGORY_LABELS: Record<string, string> = {
  lecture_notes: 'Lecture notes',
  sample_exams: 'Past exams',
  book_chapters: 'Book chapters',
  syllabus: 'Syllabus or schedule',
}

/** The sort used by "Needs work": due topics first, then the lowest mastery, not started included. */
export function needsWorkOrder<T extends { mastery: number | null; dueAt: string | null; orderIndex: number }>(
  topics: T[],
  now: number
): T[] {
  const due = (topic: T) => (topic.dueAt && new Date(topic.dueAt).getTime() <= now ? 0 : 1)
  return [...topics].sort((a, b) => {
    if (due(a) !== due(b)) return due(a) - due(b)
    const left = a.mastery ?? -1
    const right = b.mastery ?? -1
    if (left !== right) return left - right
    return a.orderIndex - b.orderIndex
  })
}

/**
 * When a topic is next reviewed: "Due today" (or "Overdue 2d") for anything due by the end of
 * the student's today, otherwise "Next review in 4 days". Null when there is no schedule yet.
 */
export function reviewTiming(dueAt: string | null, now: number, timeZone = 'UTC'): { due: boolean; text: string } | null {
  if (!dueAt) return null
  if (isReviewDue(dueAt, dueBoundary(new Date(now), timeZone))) return { due: true, text: formatDueLabel(dueAt, now) }
  return { due: false, text: `Next review ${formatRelative(dueAt, now)}` }
}

export type GlyphState = 'done' | 'ready' | 'missing'

/** Notes, examples, practice and quiz states for the topics list. Practice is done when the server has most of its steps solved. */
export function studyPath(topic: {
  content: string[]
  progress: { notes: boolean; examples: boolean; quiz: boolean; quizScore: number | null }
  /** At least 80% of the practice steps are solved (stored on the server). */
  practiceDone?: boolean
}): { notes: GlyphState; examples: GlyphState; practice: GlyphState; quiz: GlyphState; quizScore: number | null } {
  const has = (type: string) => topic.content.includes(type)
  const state = (type: string, done: boolean): GlyphState => (done ? 'done' : has(type) ? 'ready' : 'missing')
  return {
    notes: state('section_notes', topic.progress.notes),
    examples: state('solved_examples', topic.progress.examples),
    practice: state('interactive_examples', topic.practiceDone === true),
    quiz: state('topic_quiz', topic.progress.quiz),
    quizScore: topic.progress.quizScore,
  }
}
