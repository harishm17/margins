/**
 * Relays the AI service's answer stream to the browser while the server stores the result.
 *
 * The browser gets the AI service's events as they arrive (text, citations), with `thread`
 * and `user_message` events first and `saved` last. The relay keeps reading the AI service
 * even when the browser has gone away, so a closed tab still ends with the answer stored and
 * its cost recorded, instead of a paid answer nobody can find.
 */
import { createLineSplitter, parseChatEvent } from './events'
import { chatErrorMessage } from './errors'
import type { ChatSource, CitationMark } from './citations'

export type UsageInfo = { model: string; inputTokens: number; outputTokens: number; costUsd: number }

export type AnswerRecord = {
  text: string
  sources: ChatSource[]
  marks: CitationMark[]
  usage: UsageInfo
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
    costUsd: number(raw.cost_usd),
  }
}

type Json = Record<string, unknown>

export function relayChatStream(args: {
  /** Events sent before the AI service's own (thread, user_message). */
  head: Json[]
  upstream: ReadableStream<Uint8Array>
  storage: ChatStorage
  log?: (message: string, error?: unknown) => void
}): ReadableStream<Uint8Array> {
  const { head, upstream, storage } = args
  const log = args.log ?? ((message, error) => console.error(`[CHAT] ${message}`, error ?? ''))
  const encoder = new TextEncoder()
  let clientGone = false

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

            if (event.type === 'done') {
              finished = true
              const usage = parseUsage(raw.usage) ?? { model: '', inputTokens: 0, outputTokens: 0, costUsd: 0 }
              // The browser sees the finished answer before the database write.
              send({ ...raw, usage: undefined })
              let messageId: string | null = null
              const saved = await safely('saving the answer', async () => {
                messageId = await storage.saveAnswer({
                  text: event.text,
                  sources: event.sources,
                  marks: event.marks,
                  usage,
                })
              })
              if (saved && messageId) send({ type: 'saved', messageId })
              else sendError('CHAT_NOT_SAVED')
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
      // The browser left. The loop above keeps going so the answer is still stored.
      clientGone = true
    },
  })
}
