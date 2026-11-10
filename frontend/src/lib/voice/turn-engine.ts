/**
 * One voice turn: the student's words go to the model, the model may ask for tools, the
 * server runs them and calls the model again, until it has said what it has to say.
 *
 * No network or database in here: the model and the tools are passed in, so the loop can be
 * tested with fakes. It reports to the browser through `emit` (text, question, evaluation,
 * hint, session_complete and error events). The final `done` event is the caller's to send,
 * once it has stored the conversation.
 */
import { logServerError } from '@/lib/ops/log'
import type { ModelEvent } from '@/lib/voice/ai-turn'
import { VoiceModelError } from '@/lib/voice/ai-turn'
import { voiceErrorMessage } from '@/lib/voice/errors'
import { FINISH_CUT_OFF_NOTE, type VoiceBlock, type VoiceMessage } from '@/lib/voice/history'
import type { VoiceToolResult } from '@/lib/voice/tools'
import type { VoiceEvent } from '@/lib/voice/turn-client'
import type { VoiceStreamExtra } from '@/lib/voice/turn-contract'

/** Model calls in one turn: the reply, and up to three rounds of tool results. */
export const MAX_MODEL_CALLS = 4

export type TurnDeps = {
  /** Starts a model call for the conversation so far. Throws VoiceModelError when it is refused. */
  openModel(messages: VoiceMessage[], callNumber: number): Promise<AsyncIterable<ModelEvent>>
  runTool(name: string, input: Record<string, unknown>): Promise<VoiceToolResult>
  emit(event: VoiceEvent | VoiceStreamExtra): void
  maxModelCalls?: number
  /** Milliseconds on a monotonic clock; performance.now() unless a test brings its own. */
  now?: () => number
  /** When model call `call` was started, if that was before the engine was asked for it (the route opens the first one early). */
  callStartedAt?: (call: number) => number | undefined
  log?: (message: string, error?: unknown) => void
  /**
   * PROMPTS_V2 (area voice, R7): a call that ends at max_tokens is cut off mid-reply. What it said has been streamed and is
   * being spoken, so it stays said; the coach is asked to finish in a sentence without repeating it.
   */
  retryCutOff?: boolean
}

/** One model call: milliseconds to its first token (null when it said and asked for nothing) and in all. */
export type CallTiming = { ttftMs: number | null; totalMs: number }

export type TurnOutcome = {
  /** The conversation up to the last complete step: tool results included, a failed call not. */
  messages: VoiceMessage[]
  /** Everything the coach said this turn. */
  text: string
  /** The text of a reply that was streamed to the student but did not finish (the model call broke or the browser left). It is not in `messages`. */
  cutOff: string
  ok: boolean
  error: { code: string; retryable: boolean } | null
  /** At least one tool ran, so the conversation must be kept even though the turn failed. */
  toolsRan: boolean
  /** The drill finished during this turn. */
  sessionComplete: boolean
  /** Timing of each model call, in order (spec 19.10). */
  calls: CallTiming[]
  /** Milliseconds spent running tools the model asked for. */
  toolMs: number
}

function textOf(content: VoiceBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

export async function runTurn(deps: TurnDeps, start: VoiceMessage[]): Promise<TurnOutcome> {
  const log = deps.log ?? ((_message, error) => logServerError('Voice: the turn loop reported a problem', error))
  const max = deps.maxModelCalls ?? MAX_MODEL_CALLS
  const now = deps.now ?? (() => performance.now())
  const calls: CallTiming[] = []
  let toolMs = 0
  let messages = [...start]
  const spoken: string[] = []
  let toolsRan = false
  let sessionComplete = false

  /** `cutOff` is what the unfinished model call had streamed: the student may have heard it, so it counts as said. */
  const fail = (code: string, retryable?: boolean, cutOff = ''): TurnOutcome => {
    const info = voiceErrorMessage(code)
    deps.emit({ type: 'error', code, message: info.message, retryable: retryable ?? info.retryable })
    if (cutOff.trim()) spoken.push(cutOff.trim())
    return {
      messages,
      text: spoken.join(' '),
      cutOff: cutOff.trim(),
      ok: false,
      error: { code, retryable: retryable ?? info.retryable },
      toolsRan,
      sessionComplete,
      calls,
      toolMs,
    }
  }

  async function runTools(toolCalls: VoiceBlock[]): Promise<VoiceBlock[]> {
    const results: VoiceBlock[] = []
    for (const block of toolCalls) {
      const name = String(block.name ?? '')
      const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}
      let result: VoiceToolResult
      const toolStarted = now()
      try {
        result = await deps.runTool(name, input)
      } catch (error) {
        log(`Tool ${name} failed`, error)
        result = { output: { error: 'The tool failed. Tell the student and carry on.' }, events: [], sessionComplete: false, isError: true }
      }
      toolMs += now() - toolStarted
      toolsRan = true
      if (result.sessionComplete) sessionComplete = true
      for (const event of result.events) deps.emit(event)
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.output),
        ...(result.isError ? { is_error: true } : {}),
      })
    }
    return results
  }

  for (let call = 1; call <= max; call += 1) {
    let events: AsyncIterable<ModelEvent>
    const callStarted = deps.callStartedAt?.(call) ?? now()
    let firstToken: number | null = null
    // Whatever way the call ends, it is timed.
    const timed = () => calls.push({ ttftMs: firstToken === null ? null : Math.round(firstToken - callStarted), totalMs: Math.round(now() - callStarted) })
    try {
      events = await deps.openModel(messages, call)
    } catch (error) {
      if (error instanceof VoiceModelError) {
        log(`The AI service refused call ${call}: ${error.code}: ${error.message}`)
        return fail(error.code, error.retryable)
      }
      log(`The AI service is not reachable (call ${call})`, error)
      return fail('VOICE_UNAVAILABLE')
    }

    let segment = ''
    let done: Extract<ModelEvent, { type: 'done' }> | null = null
    try {
      for await (const event of events) {
        if ((event.type === 'text' || event.type === 'tool_use') && firstToken === null) firstToken = now()
        if (event.type === 'text') {
          // Two spoken segments in one turn (before and after a tool) need a space between them.
          if (!segment && spoken.length > 0 && !/\s$/.test(spoken[spoken.length - 1])) {
            deps.emit({ type: 'text', delta: ' ' })
          }
          segment += event.delta
          deps.emit({ type: 'text', delta: event.delta })
        } else if (event.type === 'done') {
          done = event
        } else if (event.type === 'error') {
          log(`The AI service reported ${event.code}: ${event.message}`)
          timed()
          return fail(event.code, event.retryable, segment)
        }
        // tool_use events are only a preview: the blocks in `done` are what counts.
      }
    } catch (error) {
      log(`The AI service stream broke (call ${call})`, error)
      timed()
      return fail('VOICE_INTERRUPTED', undefined, segment)
    }
    timed()
    if (!done) return fail('VOICE_INTERRUPTED', undefined, segment)
    if (deps.retryCutOff && done.stopReason === 'max_tokens') {
      // The reply was cut off, and any tool call in it is incomplete. Its words went to the browser as they came and are
      // being spoken: taking them back and asking again from the same conversation made the coach say the same opening
      // twice. They stay in the conversation, and the coach is asked to finish without repeating them. With no call left
      // the turn fails, and what was said is stored as a reply that did not finish.
      log(`Model call ${call} ended at max_tokens`)
      if (call === max) return fail('VOICE_TURN_FAILED', undefined, segment)
      const said = segment.trim()
      if (said) {
        spoken.push(said)
        messages = [...messages, { role: 'assistant', content: [{ type: 'text', text: said }] }, { role: 'user', content: FINISH_CUT_OFF_NOTE }]
      }
      continue
    }
    if (segment.trim()) spoken.push(segment.trim())

    // A tool call cut off by max_tokens is incomplete: do not send it back.
    const wantsTools = done.stopReason === 'tool_use'
    const content = wantsTools ? done.content : done.content.filter((block) => block.type !== 'tool_use')
    messages = [...messages, { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: textOf(done.content) }] }]

    const toolCalls = wantsTools ? done.content.filter((block) => block.type === 'tool_use') : []
    if (toolCalls.length === 0 || call === max) {
      if (toolCalls.length > 0) {
        // Out of calls with tool requests still pending. Answer them so the stored
        // conversation stays valid, but do not ask the model to speak again this turn.
        const results = await runTools(toolCalls)
        messages = [...messages, { role: 'user', content: results }]
      }
      return { messages, text: spoken.join(' '), cutOff: '', ok: true, error: null, toolsRan, sessionComplete, calls, toolMs }
    }

    const results = await runTools(toolCalls)
    messages = [...messages, { role: 'user', content: results }]
  }

  // Unreachable: the loop always returns on its last call.
  return fail('VOICE_TURN_FAILED')
}
