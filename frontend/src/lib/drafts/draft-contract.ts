// What a draft is, shared by the server store, the API route and the browser hook (spec §18.7).
// No database or React imports: this file is safe in both places.

import { z } from 'zod'
import { isConfidenceId } from '@/lib/learning/calibration'
import { LEGACY_IDK_MARKER } from '@/lib/learning/quiz-answers'

export const DRAFT_SURFACES = ['quiz', 'recall', 'reader_check', 'explainer_check', 'review', 'practice'] as const
export type DraftSurface = (typeof DRAFT_SURFACES)[number]

export const isDraftSurface = (value: unknown): value is DraftSurface =>
  typeof value === 'string' && (DRAFT_SURFACES as readonly string[]).includes(value)

/** The most a payload may take, as UTF-8 bytes of its JSON. */
export const MAX_DRAFT_BYTES = 16 * 1024
/** A draft lives this long after its last write. */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** A user may hold this many live drafts; a new one beyond it is refused (an edit to an existing one never is). */
export const MAX_DRAFTS_PER_USER = 500
/** Quiet time before the hook saves, and the longest a stream of edits waits. */
export const DRAFT_DEBOUNCE_MS = 800
export const DRAFT_MAX_WAIT_MS = 10_000

export function payloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload) ?? '').length
}

// ---- Keys (the `scopeKey` column) ----

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/
const INDEX = /^\d{1,4}$/

/** How many `:`-separated parts each surface's key has, and which of them are indexes. */
const KEY_SHAPE: Record<DraftSurface, { parts: number; indexes: number[]; topicAt?: number }> = {
  quiz: { parts: 2, indexes: [], topicAt: 0 }, // <topicId>:<quizSetId>
  recall: { parts: 2, indexes: [], topicAt: 0 }, // <topicId>:<cardKey>
  reader_check: { parts: 1, indexes: [] }, // <claimId>
  explainer_check: { parts: 2, indexes: [], topicAt: 0 }, // <topicId>:<blockId>
  review: { parts: 2, indexes: [1] }, // <sessionId>:<index>
  practice: { parts: 3, indexes: [1, 2] }, // <contentId>:<problemIndex>:<stepIndex>
}

/** The key's parts when it has this surface's shape, else null. */
export function parseDraftKey(surface: DraftSurface, key: string): string[] | null {
  if (key.length > 300) return null
  const shape = KEY_SHAPE[surface]
  const parts = key.split(':')
  if (parts.length !== shape.parts) return null
  for (const [i, part] of parts.entries()) {
    if (!(shape.indexes.includes(i) ? INDEX : SEGMENT).test(part)) return null
  }
  return parts
}

/** The topic a key names, for the surfaces whose key starts with one; null for the others. */
export function topicOfKey(surface: DraftSurface, key: string): string | null {
  const at = KEY_SHAPE[surface].topicAt
  const parts = parseDraftKey(surface, key)
  return at === undefined || !parts ? null : parts[at]
}

/** The quiz set a `quiz` key names. */
export function quizSetOfKey(key: string): string | null {
  return parseDraftKey('quiz', key)?.[1] ?? null
}

/** Whether the surface's key starts with a topic id, which the request must then carry as `topicId`. */
export const surfaceNamesTopic = (surface: DraftSurface) => KEY_SHAPE[surface].topicAt !== undefined

// ---- Payloads (spec §18.7 table) ----

const text = (max: number) => z.string().max(max)
const confidence = z.number().min(0).max(1)
const confidenceLevel = z.string().refine(isConfidenceId)

const IDK_ANSWER = { answer: '', idk: true as const }
const quizAnswer = z.union([
  // A quiz started before confidence existed stored plain strings.
  text(4000).transform((answer) => (answer === LEGACY_IDK_MARKER ? IDK_ANSWER : { answer })),
  z
    .object({
      answer: text(4000),
      confidence: confidence.optional(),
      confidenceLevel: confidenceLevel.optional(),
      thinking: text(4000).optional(),
      // "I don't know": nothing answered, so no text, confidence or thinking is kept.
      idk: z.boolean().optional(),
    })
    .transform((entry) => (entry.idk === true || entry.answer === LEGACY_IDK_MARKER ? IDK_ANSWER : entry)),
])

const QUIZ = z.object({
  answers: z.record(z.string().regex(INDEX), quizAnswer).refine((a) => Object.keys(a).length <= 200),
  index: z.number().int().min(0).max(1000),
  predicted: z.number().int().min(0).max(1000).optional(),
})

const PAYLOADS: Record<DraftSurface, z.ZodType<unknown>> = {
  quiz: QUIZ,
  recall: z.object({ text: text(12_000), voice: z.boolean() }),
  reader_check: z.object({ answer: text(4000), revealed: z.boolean() }),
  explainer_check: z.object({ answer: text(4000) }),
  review: z.object({
    answer: text(4000),
    thinking: text(4000).optional(),
    confidence: confidence.optional(),
    confidenceLevel: confidenceLevel.optional(),
  }),
  practice: z.object({ answer: text(4000), working: text(8000) }),
}

export type QuizDraftPayload = z.output<typeof QUIZ>
export type DraftPayloads = {
  quiz: QuizDraftPayload
  recall: { text: string; voice: boolean }
  reader_check: { answer: string; revealed: boolean }
  explainer_check: { answer: string }
  review: { answer: string; thinking?: string; confidence?: number; confidenceLevel?: string }
  practice: { answer: string; working: string }
}

export type PayloadCheck = { ok: true; payload: unknown } | { ok: false; reason: 'too_large' | 'invalid'; message: string }

/**
 * Checks a payload against the surface's shape and the size cap. Returns the cleaned payload (unknown
 * fields dropped, old quiz answer strings turned into objects), which is what gets stored.
 */
export function validateDraftPayload(surface: DraftSurface, payload: unknown): PayloadCheck {
  const bytes = payloadBytes(payload)
  if (bytes > MAX_DRAFT_BYTES) return { ok: false, reason: 'too_large', message: `Draft is ${bytes} bytes; the limit is ${MAX_DRAFT_BYTES}.` }
  const parsed = PAYLOADS[surface].safeParse(payload)
  if (!parsed.success) return { ok: false, reason: 'invalid', message: `Draft does not match the ${surface} shape.` }
  // Cleaning can only shrink a payload, except turning "a" into {"answer":"a"}: check again.
  if (payloadBytes(parsed.data) > MAX_DRAFT_BYTES) return { ok: false, reason: 'too_large', message: `Draft is larger than ${MAX_DRAFT_BYTES} bytes.` }
  return { ok: true, payload: parsed.data }
}

// ---- Wire shapes ----

/** A stored draft as the API sends it (dates as ISO strings). */
export type DraftWire<T = unknown> = { payload: T; version: number; updatedAt: string; expiresAt: string }
