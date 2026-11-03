import { parseSources } from '@/lib/topics/sources'
import type {
  ExamplesContent,
  NotesContent,
  PracticeContent,
  PracticeProblem,
  PracticeStep,
  SolvedExample,
  SolvedStep,
  TopicCitation,
} from './types'

/**
 * Generated content arrives as loose JSON (snake_case, written by a model). These readers pick
 * out what the page needs and drop anything malformed, so one odd item never breaks a view.
 */

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value))
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const strings = (value: unknown): string[] =>
  list(value)
    .map(text)
    .map((item) => item.trim())
    .filter(Boolean)

export function parseCitations(metadata: unknown): TopicCitation[] {
  const raw = isRecord(metadata) ? list(metadata.citations) : []
  const seen = new Set<string>()
  const citations: TopicCitation[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const filename = text(item.filename).trim()
    if (!filename) continue
    const pages = text(item.pages).trim()
    const page = typeof item.page === 'number' && Number.isFinite(item.page) ? item.page : null
    const materialId = typeof item.material_id === 'string' && item.material_id ? item.material_id : null
    const citation: TopicCitation = {
      filename,
      pages: pages && pages.toLowerCase() !== 'n/a' ? pages : null,
      materialId,
      page,
    }
    const key = `${materialId ?? filename}|${citation.pages ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    citations.push(citation)
  }
  return citations
}

export function parseNotes(contentData: unknown, metadata: unknown, updatedAt: string): NotesContent | null {
  const body = typeof contentData === 'string' ? contentData : isRecord(contentData) ? text(contentData.content) : ''
  if (!body.trim()) return null
  return { text: body, citations: parseCitations(metadata), updatedAt }
}

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const

export function parseSolvedExamples(contentData: unknown, updatedAt: string): ExamplesContent | null {
  const items: SolvedExample[] = []
  for (const raw of list(contentData)) {
    if (!isRecord(raw)) continue
    const title = text(raw.title).trim()
    const problem = text(raw.problem_statement).trim()
    if (!title && !problem) continue
    const exampleConceptIds = strings(raw.concept_ids)
    const steps: SolvedStep[] = list(raw.solution_steps)
      .filter(isRecord)
      .map((step, index) => ({
        number: typeof step.step_number === 'number' ? step.step_number : index + 1,
        description: text(step.description).trim(),
        work: text(step.work).trim(),
        explanation: text(step.explanation).trim(),
        conceptIds: strings(step.concept_ids).length > 0 ? strings(step.concept_ids) : exampleConceptIds,
      }))
    const difficulty = DIFFICULTIES.find((level) => level === text(raw.difficulty).toLowerCase()) ?? null
    items.push({
      title: title || `Example ${items.length + 1}`,
      problem,
      steps,
      finalAnswer: Array.isArray(raw.final_answer) ? strings(raw.final_answer).map((line) => `- ${line}`).join('\n') : text(raw.final_answer).trim(),
      keyConcepts: strings(raw.key_concepts),
      difficulty,
      conceptIds: exampleConceptIds,
      sources: parseSources(raw.sources),
    })
  }
  return items.length ? { items, updatedAt } : null
}

const ANSWER_TYPES = ['numeric', 'text', 'multiple_choice'] as const

/** Locate, connect, structure. Content from before hint rungs has one `hint`, which is the connect hint. */
function stepHints(step: Record<string, unknown>): [string, string, string] {
  const hints = strings(step.hints).map((hint) => hint.trim())
  if (hints.length === 3) return [hints[0], hints[1], hints[2]]
  return ['', text(step.hint).trim(), '']
}

export function parsePracticeProblems(contentData: unknown, updatedAt: string): PracticeContent | null {
  const items: PracticeProblem[] = []
  for (const raw of list(contentData)) {
    if (!isRecord(raw)) continue
    const problemConceptIds = strings(raw.concept_ids)
    const steps: PracticeStep[] = list(raw.steps)
      .filter(isRecord)
      .map((step, index) => ({
        number: typeof step.step_number === 'number' ? step.step_number : index + 1,
        question: text(step.question).trim(),
        hint: text(step.hint).trim(),
        hints: stepHints(step),
        conceptIds: strings(step.concept_ids).length > 0 ? strings(step.concept_ids) : problemConceptIds,
        answerType: ANSWER_TYPES.find((type) => type === text(step.answer_type)) ?? 'text',
        options: list(step.options)
          .filter(isRecord)
          .map((option) => ({ id: text(option.id).trim(), text: text(option.text).trim() }))
          .filter((option) => option.id && option.text),
        correctAnswer: text(step.correct_answer).trim(),
        acceptableAnswers: strings(step.acceptable_answers),
        tolerance: typeof step.tolerance === 'number' && Number.isFinite(step.tolerance) && step.tolerance >= 0 ? step.tolerance : null,
        explanation: text(step.explanation).trim(),
        feedbackCorrect: text(step.feedback_correct).trim(),
        feedbackIncorrect: text(step.feedback_incorrect).trim(),
      }))
      .filter((step) => step.question && step.correctAnswer)
    if (steps.length === 0) continue
    items.push({
      title: text(raw.title).trim() || `Problem ${items.length + 1}`,
      problem: text(raw.problem_statement).trim(),
      steps,
      keyConcepts: strings(raw.key_concepts),
      conceptIds: problemConceptIds,
      difficulty: text(raw.difficulty).trim() || null,
      minutes: typeof raw.estimated_time_minutes === 'number' ? raw.estimated_time_minutes : null,
      sources: parseSources(raw.sources),
    })
  }
  return items.length ? { items, updatedAt } : null
}
