/**
 * What Ask tutored on one reply (spec §6.3), as it is stored on the assistant message (`ChatMessage.tutor`)
 * and as the browser sees it. The stored form holds the check card's answer and explanation; the browser
 * is only ever given the view, and the answer is shown when the student asks for it, with an attempt (POST /api/ask-checks/reveal).
 * Pure: no database, no React.
 */
import type { CheckGrade } from '@/lib/reader/checks'

export const ASK_INTENTS = ['lookup', 'logistics', 'understand', 'solve', 'check_answer', 'other'] as const
export type AskIntent = (typeof ASK_INTENTS)[number]

/** What the "Show me a worked example" button sends. It is worded so that the router takes it for a request to be worked, never for a lookup. */
export const WORKED_EXAMPLE_REQUEST =
  'Show me a worked example of a similar problem with different numbers, and then I will apply it to my own problem.'

const GRADES: readonly CheckGrade[] = ['got_it', 'partly', 'missed']

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [])

/** The AI service's `route` event: what the student's message is for and the course concepts it touches. */
export type AskRoute = {
  intent: AskIntent
  hasAttempt: boolean
  wantsAnswer: boolean
  /** Concept names and, in the same order, the ids that could be resolved (fewer when some could not). */
  concepts: string[]
  conceptIds: string[]
  broad: boolean
  degraded: boolean
}

export function parseRoute(raw: unknown): AskRoute | null {
  if (!isRecord(raw) || !(ASK_INTENTS as readonly unknown[]).includes(raw.intent)) return null
  return {
    intent: raw.intent as AskIntent,
    hasAttempt: raw.has_attempt === true,
    wantsAnswer: raw.wants_answer === true,
    concepts: strings(raw.concepts),
    conceptIds: strings(raw.concept_ids),
    broad: raw.broad === true,
    degraded: raw.degraded === true,
  }
}

/** The card as the AI service sends it with `done`. */
export type CheckCard = { question: string; answer: string; explanation: string; conceptName: string }

export function parseCard(raw: unknown): CheckCard | null {
  if (!isRecord(raw)) return null
  const question = text(raw.question)
  const answer = text(raw.answer)
  if (!question || !answer) return null
  return { question, answer, explanation: text(raw.explanation), conceptName: text(raw.concept_name) }
}

export type StoredCheck = CheckCard & {
  /** The concept the card tests, when the route named one that resolved; the self-grade is filed under it. */
  conceptId: string | null
  /** What the student tried before the answer was shown: their words, or "I don't know". Kept by the server; the answer is not returned without it. */
  attempt: { text: string; idk: boolean } | null
  /** The student's grade, once given. A card is graded once. */
  grade: CheckGrade | null
}

export type StoredTutor = {
  route: { intent: AskIntent; broad: boolean; concepts: string[] }
  check: StoredCheck | null
}

/**
 * The concept a card is about: the routed concept it names. The AI service names the only routed concept
 * when the model did not, so a card with no name is unattributed and records nothing.
 */
export function cardConceptId(card: CheckCard, route: AskRoute): string | null {
  if (!card.conceptName) return null
  const named = route.concepts.findIndex((name) => name.toLowerCase() === card.conceptName.toLowerCase())
  return named >= 0 ? (route.conceptIds[named] ?? null) : null
}

export function toStoredTutor(route: AskRoute, card: CheckCard | null): StoredTutor {
  return {
    route: { intent: route.intent, broad: route.broad, concepts: route.concepts },
    check: card ? { ...card, conceptId: cardConceptId(card, route), attempt: null, grade: null } : null,
  }
}

export function parseStoredTutor(value: unknown): StoredTutor | null {
  if (!isRecord(value) || !isRecord(value.route) || !(ASK_INTENTS as readonly unknown[]).includes(value.route.intent)) return null
  const stored = value.check
  const card = isRecord(stored) ? parseCard({ ...stored, concept_name: stored.conceptName }) : null
  const check =
    isRecord(stored) && card
      ? { ...card, conceptId: typeof stored.conceptId === 'string' ? stored.conceptId : null, attempt: attemptOf(stored.attempt), grade: gradeOf(stored.grade) }
      : null
  return {
    route: { intent: value.route.intent as AskIntent, broad: value.route.broad === true, concepts: strings(value.route.concepts) },
    check,
  }
}

const attemptOf = (value: unknown): StoredCheck['attempt'] =>
  isRecord(value) && (text(value.text) !== '' || value.idk === true) ? { text: text(value.text), idk: value.idk === true } : null

const gradeOf = (value: unknown): CheckGrade | null => GRADES.find((grade) => grade === value) ?? null

/** What the browser is told about a reply's check question: the question, never the answer. */
export type CheckView = { question: string; conceptName: string; grade: CheckGrade | null }

/** What the browser is told about a reply: its kind, the places to start for a broad question, and its card. */
export type AskTurnView = {
  intent: AskIntent
  /** Course concepts to offer as places to start (a broad question only). */
  entryPoints: string[]
  check: CheckView | null
}

export function turnView(stored: StoredTutor | null): AskTurnView | null {
  if (!stored) return null
  return {
    intent: stored.route.intent,
    entryPoints: stored.route.broad ? stored.route.concepts.slice(0, 3) : [],
    check: stored.check ? { question: stored.check.question, conceptName: stored.check.conceptName, grade: stored.check.grade } : null,
  }
}

/** The `done` event as the browser gets it: the card's question and concept, without its answer or explanation. */
export function browserCard(card: CheckCard | null): { question: string; concept_name: string } | null {
  return card ? { question: card.question, concept_name: card.conceptName } : null
}

/** Parse the view back out of a `done` or thread payload. */
export function parseCheckView(raw: unknown): CheckView | null {
  if (!isRecord(raw)) return null
  const question = text(raw.question)
  if (!question) return null
  return { question, conceptName: text(raw.concept_name ?? raw.conceptName), grade: gradeOf(raw.grade) }
}
