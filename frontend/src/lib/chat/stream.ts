/**
 * Relays the AI service's answer stream to the browser while the server stores the result.
 *
 * The browser gets the AI service's events as they arrive (text, citations), with `thread`
 * and `user_message` events first and `saved` last. When the browser goes away the relay cancels the AI
 * service's stream: the model call stops (the AI service records what was spent so far) and the question is
 * removed through the usual failure path, so a closed tab leaves no unanswered turn and nothing keeps running.
 */
import { logServerError } from '@/lib/ops/log'
import { createLineSplitter, parseChatEvent } from './events'
import { chatErrorMessage } from './errors'
import type { ChatSource, CitationMark } from './citations'

/** `inputTokens` includes the cache reads and writes, which are also given apart (A4). */
export type UsageInfo = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }

const NO_USAGE: UsageInfo = { model: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }

export type AnswerRecord = {
  text: string
  sources: ChatSource[]
  marks: CitationMark[]
  usage: UsageInfo
  /** What Ask tutored on this reply, stored with it (see lib/ask/tutor-message.ts). */
  tutor?: unknown
}

export type ChatStorage = {
  /** Store the assistant message; resolves to its id. */
  saveAnswer(record: AnswerRecord): Promise<string>
  /**
   * The answer failed. `usage` is set when the model was called and billed: its cost still goes
   * on the ledger, so it counts toward the daily budget. A failure is never kept in the
   * conversation: the question is removed (and a conversation it started, now empty), so the
   * thread has no unanswered turn and the browser offers the retry. `discarded` says the
   * question is gone.
   */
  recordFailure(code: string, usage: UsageInfo | null): Promise<{ discarded: boolean } | void>
}

export function parseUsage(value: unknown): UsageInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    model: typeof raw.model === 'string' ? raw.model : '',
    inputTokens: Math.round(number(raw.input_tokens)),
    outputTokens: Math.round(number(raw.output_tokens)),
    cacheReadTokens: Math.round(number(raw.cache_read_tokens)),
    cacheWriteTokens: Math.round(number(raw.cache_write_tokens)),
    costUsd: number(raw.cost_usd),
  }
}

type Json = Record<string, unknown>

/** Ask's part in the relay: it reads the AI service's events and adds its own. All optional. */
export type RelayHooks = {
  /** Every event from the AI service, before it is handled (the route comes first). */
  onEvent?(raw: Json): void
  /** The finished answer: what is stored with it, and what the browser is sent in its place (it may hide parts). */
  onDone?(raw: Json): { tutor?: unknown; send?: Json } | undefined
  /** The answer is stored: more events for the browser, sent after `saved`. A failure here is logged and the stream still ends well. */
  afterSaved?(messageId: string): Promise<Json[]>
}

export function relayChatStream(args: {
  /** Events sent before the AI service's own (thread, user_message). */
  head: Json[]
  upstream: ReadableStream<Uint8Array>
  storage: ChatStorage
  hooks?: RelayHooks
  log?: (message: string, error?: unknown) => void
}): ReadableStream<Uint8Array> {
  const { head, upstream, storage } = args
  const hooks = args.hooks ?? {}
  const log = args.log ?? ((_message, error) => logServerError('Chat: the answer stream reported a problem', error))
  const encoder = new TextEncoder()
  let clientGone = false
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: Json) => {
        if (clientGone) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        } catch {
          clientGone = true
        }
      }
      const sendError = (code: string, discarded = false) => {
        const info = chatErrorMessage(code)
        send({ type: 'error', code, message: info.message, retryable: info.retryable, ...(discarded ? { discarded } : {}) })
      }
      // Record the failure, then tell the browser, including whether the question was removed.
      const fail = async (code: string, usage: UsageInfo | null) => {
        let discarded = false
        await safely('recording the failure', async () => {
          discarded = (await storage.recordFailure(code, usage))?.discarded === true
        })
        sendError(code, discarded)
      }
      const safely = async (what: string, work: () => Promise<unknown>): Promise<boolean> => {
        try {
          await work()
          return true
        } catch (error) {
          log(`${what} failed`, error)
          return false
        }
      }

      void (async () => {
        let finished = false
        try {
          for (const event of head) send(event)

          const handle = async (line: string) => {
            const event = parseChatEvent(line)
            if (!event || finished) return
            let raw: Json = {}
            try {
              raw = JSON.parse(line) as Json
            } catch {
              return
            }
            await safely('reading an event', async () => hooks.onEvent?.(raw))

            if (event.type === 'done') {
              finished = true
              const usage = parseUsage(raw.usage) ?? NO_USAGE
              let extra: { tutor?: unknown; send?: Json } | undefined
              await safely('preparing the answer', async () => {
                extra = hooks.onDone?.(raw)
              })
              // The browser sees the finished answer before the database write.
              send({ ...(extra?.send ?? raw), usage: undefined })
              let messageId: string | null = null
              const saved = await safely('saving the answer', async () => {
                messageId = await storage.saveAnswer({
                  text: event.text,
                  sources: event.sources,
                  marks: event.marks,
                  usage,
                  ...(extra?.tutor != null ? { tutor: extra.tutor } : {}),
                })
              })
              if (saved && messageId) {
                send({ type: 'saved', messageId })
                const stored: string = messageId
                await safely('after saving the answer', async () => {
                  for (const more of (await hooks.afterSaved?.(stored)) ?? []) send(more)
                })
              } else sendError('CHAT_NOT_SAVED')
            } else if (event.type === 'error') {
              finished = true
              const usage = parseUsage(raw.usage)
              // The AI service's message can carry internal detail; the browser gets ours.
              log(`AI service reported ${event.code}: ${event.message}`)
              await fail(event.code, usage)
            } else {
              send({ ...raw, usage: undefined })
            }
          }

          const splitter = createLineSplitter()
          const reader = upstream.getReader()
          upstreamReader = reader
          if (clientGone) await reader.cancel().catch(() => {})
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            for (const line of splitter.push(value)) await handle(line)
          }
          for (const line of splitter.flush()) await handle(line)

          if (!finished) {
            finished = true
            await fail('CHAT_INTERRUPTED', null)
          }
        } catch (error) {
          log('the AI service stream broke', error)
          if (!finished) {
            finished = true
            await fail('CHAT_INTERRUPTED', null)
          }
        } finally {
          try {
            controller.close()
          } catch {
            // Already closed because the browser went away.
          }
        }
      })()
    },
    cancel() {
      // The browser left: stop the AI call. The loop above then sees the end of the stream and takes the failure path
      // (the question is removed).
      clientGone = true
      void upstreamReader?.cancel().catch(() => {})
    },
  })
}
