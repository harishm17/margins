/**
 * The chat stream, as the browser sees it: newline-delimited JSON, one event per line.
 *
 * The AI service sends route / retrieved / progress / text / citation / reset / done / error (see
 * ai-service/app/services/chat.py). The Next route adds `thread` and `user_message` first
 * and `saved` (then `tutor`) last. This file turns a stream of events into the state of one answer.
 */
import {
  type ChatSource,
  type CitationMark,
  parseMarks,
  parseSource,
} from './citations'
import { chatErrorMessage } from './errors'
import { parseCheckView, parseRoute, type AskRoute, type CheckView } from '@/lib/ask/tutor-message'

export type ChatEvent =
  | { type: 'thread'; threadId: string; title: string | null; isNew: boolean }
  | { type: 'user_message'; id: string }
  | { type: 'route'; route: AskRoute }
  | { type: 'retrieved'; count: number }
  /** A tutoring reply is written and leak-checked before any of it is sent; this says which. */
  | { type: 'progress'; stage: 'writing' | 'checking' }
  | { type: 'text'; delta: string }
  | { type: 'citation'; marker: number; offset: number; source: ChatSource }
  | { type: 'reset' }
  | {
      type: 'done'
      text: string
      sources: ChatSource[]
      marks: CitationMark[]
      retrieved: number
      stopReason: string
      /** The question that ends an explanation, shown as a card (the answer is not sent). */
      check: CheckView | null
    }
  | {
      type: 'error'
      code: string
      message: string
      retryable: boolean
      /** The server removed the question (and a conversation it had just started). */
      discarded?: boolean
    }
  | { type: 'saved'; messageId: string }
  /** After `saved`: where the thread's tutor state stands (the "Show me a worked example" button). */
  | { type: 'tutor'; workedAllowed: boolean }

/** Parse one line of the stream. Lines that are not a known event give null. */
export function parseChatEvent(line: string): ChatEvent | null {
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }

  switch (raw.type) {
    case 'thread':
      return typeof raw.threadId === 'string'
        ? {
            type: 'thread',
            threadId: raw.threadId,
            title: typeof raw.title === 'string' ? raw.title : null,
            isNew: raw.isNew === true,
          }
        : null
    case 'user_message':
      return typeof raw.id === 'string' ? { type: 'user_message', id: raw.id } : null
    case 'route': {
      const route = parseRoute(raw)
      return route ? { type: 'route', route } : null
    }
    case 'retrieved':
      return { type: 'retrieved', count: typeof raw.count === 'number' ? raw.count : 0 }
    case 'progress':
      return raw.stage === 'writing' || raw.stage === 'checking' ? { type: 'progress', stage: raw.stage } : null
    case 'text':
      return typeof raw.delta === 'string' ? { type: 'text', delta: raw.delta } : null
    case 'citation': {
      const source = parseSource(raw.source)
      const offset = typeof raw.offset === 'number' ? raw.offset : null
      return source && offset !== null && offset >= 0
        ? { type: 'citation', marker: source.marker, offset, source }
        : null
    }
    case 'reset':
      return { type: 'reset' }
    case 'done':
      return {
        type: 'done',
        text: typeof raw.text === 'string' ? raw.text : '',
        sources: Array.isArray(raw.sources)
          ? raw.sources.map(parseSource).filter((s): s is ChatSource => s !== null)
          : [],
        marks: parseMarks(raw.marks),
        retrieved: typeof raw.retrieved === 'number' ? raw.retrieved : 0,
        stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : '',
        check: parseCheckView(raw.check_question),
      }
    case 'error':
      return {
        type: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'CHAT_FAILED',
        message: typeof raw.message === 'string' ? raw.message : '',
        retryable: raw.retryable !== false,
        ...(raw.discarded === true ? { discarded: true } : {}),
      }
    case 'saved':
      return typeof raw.messageId === 'string' ? { type: 'saved', messageId: raw.messageId } : null
    case 'tutor':
      return { type: 'tutor', workedAllowed: raw.workedAllowed === true }
    default:
      return null
  }
}

/**
 * Splits streamed bytes into lines. `push` returns the complete lines so far; `flush`
 * returns a last line that had no trailing newline.
 */
export function createLineSplitter() {
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    push(chunk: Uint8Array | string): string[] {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.map((line) => line.trim()).filter(Boolean)
    },
    flush(): string[] {
      buffer += decoder.decode()
      const rest = buffer.trim()
      buffer = ''
      return rest ? [rest] : []
    },
  }
}

export type AnswerStatus = 'searching' | 'writing' | 'done' | 'error'

export type AnswerState = {
  status: AnswerStatus
  /** What a tutoring reply is doing while none of it can be shown yet (it is checked before it is sent). */
  stage: 'writing' | 'checking' | null
  /** What the student's message was taken to be, once the AI service has said. */
  route: AskRoute | null
  /** The check question card that ends an explanation. */
  check: CheckView | null
  /** The thread allows the "Show me a worked example" button. */
  workedAllowed: boolean
  text: string
  marks: CitationMark[]
  sources: ChatSource[]
  retrieved: number | null
  error: { code: string; message: string; retryable: boolean } | null
  messageId: string | null
}

export const INITIAL_ANSWER: AnswerState = {
  status: 'searching',
  stage: null,
  route: null,
  check: null,
  workedAllowed: false,
  text: '',
  marks: [],
  sources: [],
  retrieved: null,
  error: null,
  messageId: null,
}

/** The answer after one more event. Pure: returns a new state. */
export function applyChatEvent(state: AnswerState, event: ChatEvent): AnswerState {
  switch (event.type) {
    case 'route':
      return { ...state, route: event.route }
    case 'retrieved':
      return { ...state, retrieved: event.count }
    case 'progress':
      return { ...state, stage: event.stage }
    case 'tutor':
      return { ...state, workedAllowed: event.workedAllowed }
    case 'text':
      return { ...state, status: 'writing', stage: null, text: state.text + event.delta }
    case 'citation': {
      const known = state.sources.some((s) => s.marker === event.marker)
      const sources = known
        ? state.sources.map((s) =>
            s.marker === event.marker && event.source.citedText && !s.citedText.includes(event.source.citedText)
              ? { ...s, citedText: [s.citedText, event.source.citedText].filter(Boolean).join('\n\n') }
              : s
          )
        : [...state.sources, event.source]
      const marks = state.marks.some((m) => m.offset === event.offset && m.marker === event.marker)
        ? state.marks
        : [...state.marks, { offset: event.offset, marker: event.marker }]
      return { ...state, sources, marks }
    }
    case 'reset':
      return { ...state, text: '', marks: [], sources: [] }
    case 'done':
      return {
        ...state,
        status: 'done',
        stage: null,
        check: event.check,
        text: event.text,
        sources: event.sources,
        marks: event.marks,
        retrieved: event.retrieved,
      }
    case 'error':
      return {
        ...state,
        status: 'error',
        error: {
          code: event.code,
          message: chatErrorMessage(event.code).message,
          retryable: event.retryable,
        },
      }
    case 'saved':
      return { ...state, messageId: event.messageId }
    default:
      return state
  }
}
