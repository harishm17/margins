/**
 * The exam guard (spec §6.3): while the student has a mock exam in progress, Ask does not answer a
 * message that is one of its questions pasted in. Pure: the route loads the open exam's questions.
 */

/** The words that carry no meaning of their own, so two questions are compared on what they are about. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'which', 'what', 'who', 'do', 'does', 'did', 'can', 'could', 'you',
  'me', 'my', 'i', 'we', 'please', 'help', 'about', 'if', 'then', 'so',
])
// Negations and comparatives ("not", "no", "never", "except", "than", "more") are not in the list: they change what a
// question asks, so they count as content.

/** At or above this token Jaccard similarity a message counts as an exam question. */
export const EXAM_GUARD_SIMILARITY = 0.5
/**
 * Or when this share of an exam question's own words is in the message (or in one sentence of it): a question pasted
 * with a long lead-in, or two of them at once, has a low Jaccard but all of the question's words.
 */
export const EXAM_GUARD_COVERAGE = 0.6
/** A question with fewer content words than this is only compared by Jaccard: a handful of common words proves nothing. */
const MIN_WORDS_FOR_COVERAGE = 4

/**
 * Lowercased words, apostrophes dropped, stopwords removed. Text is put in one composed form first, so an accent typed
 * as a letter and a pasted accent made of a letter plus a mark are the same word. A word is a run of letters and numbers
 * of any script; evals/tutoring/ask_state.py does the same with `[\W_]+` (the two agree on every assigned character).
 */
export function tokens(text: string): Set<string> {
  const words = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !STOPWORDS.has(word))
  return new Set(words)
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

const coverage = (asked: Set<string>, question: Set<string>): number => {
  if (question.size < MIN_WORDS_FOR_COVERAGE) return 0
  let shared = 0
  for (const word of question) if (asked.has(word)) shared += 1
  return shared / question.size
}

/** How many of the student's earlier messages are read together with this one. */
export const EXAM_GUARD_RECENT_TURNS = 3

/**
 * The message as a whole, then each sentence, question and line of it (a paste of several questions, or one after a
 * lead-in), then the student's last few messages joined with this one: a question asked in pieces over several
 * turns is no single message's words, and the pieces together are the question's.
 */
function chunksOf(message: string, recent: readonly string[]): Set<string>[] {
  const parts = message.split(/(?<=[.?!])\s+|\n+/).map((part) => part.trim()).filter(Boolean)
  const earlier = recent.slice(-EXAM_GUARD_RECENT_TURNS).filter((turn) => turn.trim() !== '')
  const joined = earlier.length > 0 ? [tokens([...earlier, message].join(' '))] : []
  return [tokens(message), ...(parts.length > 1 ? parts.map(tokens) : []), ...joined].filter((chunk) => chunk.size > 0)
}

/**
 * True when the message is, or nearly is, one of the open exam's questions: the same words (Jaccard 0.5), or most of
 * the question's words (0.6), in the message, in one sentence of it, or in the message joined with the student's
 * `recent` ones. A question reworded with other words or translated has none of its words: the AI service's meaning
 * check (lib/ai-service/exam-guard.ts) covers that.
 */
export function examGuard(message: string, openExamQuestions: readonly string[], recent: readonly string[] = []): boolean {
  const chunks = chunksOf(message, recent)
  if (chunks.length === 0) return false
  return openExamQuestions.some((question) => {
    const words = tokens(question)
    return chunks.some((chunk) => jaccard(chunk, words) >= EXAM_GUARD_SIMILARITY || coverage(chunk, words) >= EXAM_GUARD_COVERAGE)
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The texts to compare a message with, from an exam's stored questions: each stem, and the stem with its
 * options (a question is pasted either way). Anything that is not a question with text is skipped.
 */
export function examQuestionTexts(questions: unknown): string[] {
  if (!Array.isArray(questions)) return []
  return questions.flatMap((question): string[] => {
    if (!isRecord(question) || typeof question.question_text !== 'string' || question.question_text.trim() === '') return []
    const stem = question.question_text.trim()
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => (isRecord(option) && typeof option.text === 'string' ? [option.text] : []))
      : []
    return options.length > 0 ? [stem, `${stem} ${options.join(' ')}`] : [stem]
  })
}
