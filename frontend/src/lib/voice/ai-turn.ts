/** Calls the AI service's POST /voice/turn and reads its newline-delimited JSON reply. */
import { aiServiceHeaders } from '@/lib/ai-service/headers'
import { callSignal } from '@/lib/ai-service/client-signal'
import { createLineSplitter } from '@/lib/chat/events'
import type { VoiceBlock, VoiceMessage } from '@/lib/voice/history'

/** Most a single model call may take. A coach reply is short. */
export const MODEL_CALL_TIMEOUT_MS = 60_000

/** One event of a model call, as the AI service sends it. */
export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; stopReason: string; content: VoiceBlock[] }
  | { type: 'error'; code: string; message: string; retryable: boolean }

/** The AI service refused or could not be reached before a reply started. */
export class VoiceModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message)
    this.name = 'VoiceModelError'
  }
}

export type ModelTurnRequest = {
  userId: string
  projectId: string
  sessionId: string
  system: string
  messages: VoiceMessage[]
  tools: unknown[]
}

/** Starts a model call. Rejects on a network failure, a timeout, or when `signal` (the browser left) or the request aborts. */
export function requestModelTurn(request: ModelTurnRequest, signal?: AbortSignal): Promise<Response> {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000'
  return fetch(`${aiServiceUrl}/voice/turn`, {
    method: 'POST',
    headers: aiServiceHeaders(),
    body: JSON.stringify({
      user_id: request.userId,
      project_id: request.projectId,
      session_id: request.sessionId,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    }),
    signal: signal ? AbortSignal.any([signal, callSignal(MODEL_CALL_TIMEOUT_MS)]) : callSignal(MODEL_CALL_TIMEOUT_MS),
  })
}

/** The failure in a non-200 reply from the AI service, with a code the voice errors know. */
export async function modelErrorFromResponse(response: Response): Promise<VoiceModelError> {
  let code: string | null = null
  let retryable: boolean | null = null
  try {
    const body = (await response.json()) as { error_code?: unknown; retryable?: unknown }
    if (typeof body.error_code === 'string') code = body.error_code
    if (typeof body.retryable === 'boolean') retryable = body.retryable
  } catch {
    // Not JSON: a proxy or a crash page.
  }
  if (!code) {
    // 401, 403 and 5xx without a code: the service itself is not reachable as intended.
    code = response.status >= 500 || response.status === 401 || response.status === 403 ? 'VOICE_UNAVAILABLE' : 'VOICE_TURN_FAILED'
  }
  return new VoiceModelError(code, `The AI service answered ${response.status} (${code})`, retryable ?? true)
}

/** Parse one line of the AI service's reply. */
export function parseModelEvent(line: string): ModelEvent | null {
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (raw.type) {
    case 'text':
      return typeof raw.delta === 'string' ? { type: 'text', delta: raw.delta } : null
    case 'tool_use':
      return typeof raw.id === 'string' && typeof raw.name === 'string'
        ? {
            type: 'tool_use',
            id: raw.id,
            name: raw.name,
            input: raw.input && typeof raw.input === 'object' ? (raw.input as Record<string, unknown>) : {},
          }
        : null
    case 'done':
      return {
        type: 'done',
        stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : '',
        content: Array.isArray(raw.content)
          ? raw.content.filter(
              (block): block is VoiceBlock =>
                typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string'
            )
          : [],
      }
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

/** The events of a model call, as they arrive. */
export async function* readModelEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelEvent> {
  const splitter = createLineSplitter()
  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      for (const line of splitter.push(value)) {
        const event = parseModelEvent(line)
        if (event) yield event
      }
    }
    for (const line of splitter.flush()) {
      const event = parseModelEvent(line)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}
