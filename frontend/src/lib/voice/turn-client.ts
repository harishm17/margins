/**
 * Browser-side helpers for POST /api/voice/turn. Pure TypeScript: no React, no server imports.
 *
 * The turn answers with newline-delimited JSON.
 * `readVoiceEvents` turns a fetch response into typed events, and `createSentenceChunker`
 * turns the streamed text deltas into whole sentences that speechSynthesis can start on
 * while the rest of the reply is still being written.
 */
import { createLineSplitter } from '@/lib/chat/events'
import { MATH_SPAN } from './speakable'
import type { ListenFor, VoiceStreamExtra } from './turn-contract'

export { createLineSplitter }

export type VoiceOption = { id: string; text: string }

/** What the board shows. A question comes with `question` events; the others come with a tool result. */
export type BoardKind = 'concept' | 'prediction' | 'claim'

/** Where a board item comes from in the student's files: a label ("p. 14") and the link that opens it. */
export type BoardSource = { label: string; href: string }

export type VoiceEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'board'
      kind: BoardKind
      /** The idea to explain, the thing to predict, or the claim, as text with maths in it. */
      text: string
      /** The check question that follows a claim. */
      question?: string
      source?: BoardSource
      /** An idea to explain: which one, so a session that ends before it closes can name it. */
      idea?: { name: string; conceptId: string }
    }
  | {
      type: 'question'
      index: number
      total: number
      text: string
      questionType: string
      options?: VoiceOption[]
    }
  | {
      type: 'evaluation'
      isCorrect: boolean
      score: number
      comment: string
      explanation: string
      ungraded?: boolean
      /** A wrong answer: where the question's concepts are in the student's own file. */
      lookLinks?: BoardSource[]
    }
  | { type: 'hint'; text: string }
  | { type: 'session_complete' }
  /** A teach-back idea closed: explained (the new example held), or taught after probes, with the pages to look at again. */
  | { type: 'idea_done'; name: string; outcome: 'explained' | 'taught'; conceptId?: string; lookAgain?: string[]; lookLinks?: BoardSource[] }
  | VoiceStreamExtra
  | { type: 'done'; text: string }
  | { type: 'error'; code: string; message: string; retryable: boolean }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Links to the student's own file: a label and an address of this app. */
function readLinks(value: unknown): BoardSource[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((link): link is BoardSource => isObject(link) && typeof link.label === 'string' && typeof link.href === 'string' && link.href.startsWith('/') && !link.href.startsWith('//'))
    .map((link) => ({ label: link.label, href: link.href }))
}

function parseOptions(value: unknown): VoiceOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .filter(isObject)
    .map((option) => ({ id: String(option.id ?? ''), text: String(option.text ?? '') }))
    .filter((option) => option.id && option.text)
  return options.length > 0 ? options : undefined
}

/** Parse one line of the stream. A line that is not a known, well-formed event gives null. */
export function parseVoiceEvent(line: string): VoiceEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(raw)) return null

  switch (raw.type) {
    case 'text':
      return typeof raw.delta === 'string' ? { type: 'text', delta: raw.delta } : null
    case 'board': {
      if (typeof raw.text !== 'string' || !raw.text.trim()) return null
      const kind = raw.kind === 'concept' || raw.kind === 'prediction' || raw.kind === 'claim' ? raw.kind : null
      if (!kind) return null
      const source = isObject(raw.source) && typeof raw.source.label === 'string' && typeof raw.source.href === 'string' && raw.source.href.startsWith('/') && !raw.source.href.startsWith('//') ? { label: raw.source.label, href: raw.source.href } : undefined
      const idea = isObject(raw.idea) && typeof raw.idea.name === 'string' && raw.idea.name.trim() && typeof raw.idea.conceptId === 'string' ? { name: raw.idea.name, conceptId: raw.idea.conceptId } : undefined
      return {
        type: 'board',
        kind,
        text: raw.text,
        ...(idea ? { idea } : {}),
        ...(typeof raw.question === 'string' && raw.question.trim() ? { question: raw.question } : {}),
        ...(source ? { source } : {}),
      }
    }
    case 'question': {
      if (typeof raw.index !== 'number' || typeof raw.text !== 'string') return null
      const options = parseOptions(raw.options)
      return {
        type: 'question',
        index: raw.index,
        total: typeof raw.total === 'number' ? raw.total : 0,
        text: raw.text,
        questionType: typeof raw.questionType === 'string' ? raw.questionType : 'conceptual',
        ...(options ? { options } : {}),
      }
    }
    case 'evaluation':
      if (typeof raw.isCorrect !== 'boolean') return null
      return {
        type: 'evaluation',
        isCorrect: raw.isCorrect,
        score: typeof raw.score === 'number' ? raw.score : 0,
        comment: typeof raw.comment === 'string' ? raw.comment : '',
        explanation: typeof raw.explanation === 'string' ? raw.explanation : '',
        ...(raw.ungraded === true ? { ungraded: true } : {}),
        ...(readLinks(raw.lookLinks).length > 0 ? { lookLinks: readLinks(raw.lookLinks) } : {}),
      }
    case 'hint':
      return typeof raw.text === 'string' ? { type: 'hint', text: raw.text } : null
    case 'session_complete':
      return { type: 'session_complete' }
    case 'idea_done': {
      if (typeof raw.name !== 'string' || !raw.name || (raw.outcome !== 'explained' && raw.outcome !== 'taught')) return null
      const lookAgain = Array.isArray(raw.lookAgain) ? raw.lookAgain.filter((page): page is string => typeof page === 'string') : []
      const lookLinks = readLinks(raw.lookLinks)
      return {
        type: 'idea_done',
        name: raw.name,
        outcome: raw.outcome,
        ...(typeof raw.conceptId === 'string' && raw.conceptId ? { conceptId: raw.conceptId } : {}),
        ...(lookAgain.length > 0 ? { lookAgain } : {}),
        ...(lookLinks.length > 0 ? { lookLinks } : {}),
      }
    }
    case 'working':
      return raw.step === 'assess' || raw.step === 'record_answer' || raw.step === 'reveal' || raw.step === 'record_check' ? { type: 'working', step: raw.step } : null
    case 'listen': {
      const wanted: ListenFor[] = ['short_answer', 'prediction', 'explanation', 'none']
      return wanted.includes(raw.for as ListenFor) ? { type: 'listen', for: raw.for as ListenFor } : null
    }
    case 'done':
      return { type: 'done', text: typeof raw.text === 'string' ? raw.text : '' }
    case 'error':
      return {
        type: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'VOICE_TURN_FAILED',
        message: typeof raw.message === 'string' ? raw.message : '',
        retryable: raw.retryable !== false,
      }
    default:
      return null
  }
}

/**
 * The events of a turn response body, as they arrive. Lines that are not events are skipped.
 * Ends when the stream ends; a well-formed turn ends with `done` or `error`, so a stream that
 * ends without either was cut off (check with `isTerminal`).
 */
export async function* readVoiceEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<VoiceEvent> {
  const splitter = createLineSplitter()
  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      for (const line of splitter.push(value)) {
        const event = parseVoiceEvent(line)
        if (event) yield event
      }
    }
    for (const line of splitter.flush()) {
      const event = parseVoiceEvent(line)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

/** True for the events that end a turn. */
export function isTerminal(event: VoiceEvent): boolean {
  return event.type === 'done' || event.type === 'error'
}

// ---- Sentence chunker -----------------------------------------------------------------------

/** Words that end in a period without ending the sentence (lower case, no final period). */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'fig', 'approx', 'cf', 'al',
  'inc', 'ltd', 'vol', 'eq', 'e.g', 'i.e', 'u.s', 'u.k',
])

const TERMINATORS = '.!?…'
const CLOSERS = '"\'”’)]*_`'

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === ' '
}

/** The word that a period at `dotIndex` ends, without surrounding punctuation. */
function wordBefore(text: string, dotIndex: number): string {
  let start = dotIndex
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  return text.slice(start, dotIndex).replace(/^[("'“‘[]+/, '')
}

function isAbbreviation(word: string): boolean {
  const lower = word.toLowerCase()
  if (ABBREVIATIONS.has(lower)) return true
  // A single initial ("J. Smith") or dotted letters ("e.g", "U.S", "a.m").
  return /^[a-z]$/i.test(word) || /^(?:[a-z]\.)+[a-z]$/i.test(word)
}

/**
 * Where the first sentence in `text` ends: the index just past it and the index where the
 * next sentence starts. Null when no boundary can be confirmed yet. With `final` the end of
 * the text confirms a boundary.
 */
function findBoundary(text: string, final: boolean): { end: number; next: number } | null {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\n') {
      let next = i + 1
      while (next < text.length && (isSpace(text[next]) || text[next] === '\n')) next += 1
      return { end: i, next }
    }
    if (!TERMINATORS.includes(char)) continue

    // The run of terminators and closing quotes or brackets that ends the sentence.
    let run = i
    while (run + 1 < text.length && (TERMINATORS.includes(text[run + 1]) || CLOSERS.includes(text[run + 1]))) run += 1
    const end = run + 1
    if (end >= text.length) {
      if (final) return { end, next: end }
      return null // more text may follow ("3." then "14")
    }
    if (!isSpace(text[end]) && text[end] !== '\n') {
      i = run // "3.14", "e.g.," or "u.s.a": not a boundary
      continue
    }
    // Look past the spaces to the start of the next sentence.
    let next = end
    while (next < text.length && isSpace(text[next])) next += 1
    if (next >= text.length) {
      if (final) return { end, next }
      return null // wait for the next word to decide
    }
    if (text[next] === '\n') return { end, next }

    const single = char === '.' && [...text.slice(i, end)].filter((c) => TERMINATORS.includes(c)).length === 1
    if (single) {
      if (isAbbreviation(wordBefore(text, i))) {
        i = run
        continue
      }
      // "etc. and", "approx. five": a lower-case word continues the sentence.
      if (/\p{Ll}/u.test(text[next])) {
        i = run
        continue
      }
    }
    return { end, next }
  }
  return null
}

/** Removes markdown a speech synthesizer would read aloud ("star star"). */
export function cleanForSpeech(sentence: string): string {
  // Math keeps its notation here (x_i would lose its underscore to the markdown rules below);
  // speakable() turns it into words when the sentence is spoken.
  const math: string[] = []
  const protectedSentence = sentence.replace(MATH_SPAN, (span) => {
    math.push(span)
    return `\u0000${math.length - 1}\u0000`
  })
  return stripMarkdown(protectedSentence).replace(/\u0000(\d+)\u0000/g, (_match, index: string) => math[Number(index)] ?? '')
}

function stripMarkdown(sentence: string): string {
  return sentence
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_]*?\S)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type SentenceChunker = {
  /** Add streamed text; returns the sentences that are complete now. */
  push(delta: string): string[]
  /** The end of the reply: returns whatever is left (the last sentence has no confirmed end). */
  flush(): string[]
}

/**
 * Turns streamed text deltas into speakable sentences.
 *
 * A sentence ends at . ! ? (or ...) followed by a space and the start of the next sentence,
 * and at a newline. It does not end inside a decimal (3.14), after an abbreviation (Dr., e.g.,
 * vs.) or an initial (J. Smith), or before a lower-case word (etc. and). A sentence is held
 * back until the start of the next one has arrived, so the end of the buffer never splits
 * "3." from "14".
 *
 * `minChars` merges a sentence shorter than that into the next one (not into the last),
 * for synthesizers that sound choppy on one-word utterances. Default 0: every sentence.
 */
export function createSentenceChunker(options: { minChars?: number } = {}): SentenceChunker {
  const minChars = options.minChars ?? 0
  let buffer = ''
  let carry = ''

  const drain = (final: boolean): string[] => {
    const out: string[] = []
    while (true) {
      const boundary = findBoundary(buffer, final)
      if (!boundary) break
      const sentence = cleanForSpeech(buffer.slice(0, boundary.end))
      buffer = buffer.slice(boundary.next)
      if (!sentence) continue
      const joined = carry ? `${carry} ${sentence}` : sentence
      if (joined.length < minChars && !final) {
        carry = joined
      } else {
        carry = ''
        out.push(joined)
      }
    }
    return out
  }

  return {
    push(delta) {
      buffer += delta
      return drain(false)
    },
    flush() {
      const out = drain(true)
      const rest = cleanForSpeech(buffer)
      buffer = ''
      const tail = carry ? (rest ? `${carry} ${rest}` : carry) : rest
      carry = ''
      if (tail) out.push(tail)
      return out
    },
  }
}
