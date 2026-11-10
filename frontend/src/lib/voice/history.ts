/**
 * The coach conversation as Anthropic messages, kept on the voice session.
 *
 * Pure helpers: parse what is stored, add the student's words, and keep the last few
 * messages without breaking the pairing of tool calls and tool results.
 */

import { promptsV2 } from '@/lib/prompt-revision'

export type VoiceBlock = { type: string; [key: string]: unknown }
export type VoiceMessage = { role: 'user' | 'assistant'; content: string | VoiceBlock[] }

/** Messages kept on the session (about 15 exchanges). */
export const MAX_HISTORY_MESSAGES = 30

function isBlock(value: unknown): value is VoiceBlock {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/** The stored history, or [] when it is missing or malformed. Bad messages are dropped. */
export function parseHistory(value: unknown): VoiceMessage[] {
  if (!Array.isArray(value)) return []
  const messages: VoiceMessage[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { role, content } = entry as { role?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof content === 'string') {
      if (content.trim()) messages.push({ role, content })
    } else if (Array.isArray(content)) {
      const blocks = content.filter(isBlock)
      if (blocks.length > 0) messages.push({ role, content: blocks })
    }
  }
  return messages
}

function blocksOf(message: VoiceMessage): VoiceBlock[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
}

/**
 * `messages` plus the student's words. When the last message is already from the user (a
 * turn that failed after its tool results were stored), the words join that message, because
 * the tool results must stay at the start of it.
 */
export function appendUserText(messages: readonly VoiceMessage[], text: string): VoiceMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') {
    return [...messages.slice(0, -1), { role: 'user', content: [...blocksOf(last), { type: 'text', text }] }]
  }
  return [...messages, { role: 'user', content: text }]
}

/** True for a user message that answers a tool call. */
function hasToolResult(message: VoiceMessage): boolean {
  return message.role === 'user' && typeof message.content !== 'string' && message.content.some((b) => b.type === 'tool_result')
}

/**
 * The last `max` messages, starting at a user message that is not a tool result, so no tool
 * result is left without the tool call it answers and the conversation starts with the user.
 * When there is no such message in range the history is cut back to the latest one that is.
 */
export function trimHistory(messages: readonly VoiceMessage[], max = MAX_HISTORY_MESSAGES): VoiceMessage[] {
  let start = Math.max(0, messages.length - max)
  while (start < messages.length && (messages[start].role !== 'user' || hasToolResult(messages[start]))) start += 1
  return messages.slice(start)
}

/** With PROMPTS_V2 the history grows to this many messages before it is cut (prompt audit M6)... */
export const STEPPED_HIGH = 40
/** ...and is then cut back to about this many, so the start of the conversation, and the cache prefix, stays put between cuts. */
export const STEPPED_LOW = 20

/** The history as it is, until it passes `high` messages; then the last `low` (cut at a safe start, as `trimHistory`). */
export function trimHistorySteps(messages: readonly VoiceMessage[], high = STEPPED_HIGH, low = STEPPED_LOW): VoiceMessage[] {
  return messages.length <= high ? [...messages] : trimHistory(messages, low)
}

/**
 * The messages as they are stored: thinking blocks are left out (a thinking block is only
 * valid in the conversation that produced it, and a trimmed history is a different one).
 * A message left with no content is dropped. With `v2` the trim is in steps instead of a sliding window.
 */
export function toStoredHistory(messages: readonly VoiceMessage[], max = MAX_HISTORY_MESSAGES, v2: boolean = promptsV2('voice')): VoiceMessage[] {
  const cleaned: VoiceMessage[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      cleaned.push(message)
      continue
    }
    const blocks = message.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
    if (blocks.length > 0) cleaned.push({ role: message.role, content: blocks })
  }
  return v2 ? trimHistorySteps(cleaned) : trimHistory(cleaned, max)
}

/** Ends a reply that stopped before it was finished (the call broke, or the student left or spoke over it), for the model only. */
export const CUT_OFF_NOTE = '[This reply was cut off here.]'

/**
 * The conversation with a reply that was streamed to the student but never finished added as the coach's last message,
 * marked as cut off. Without it the turn would be missing from the conversation, and "what the student heard" sent with
 * the next turn would be written over the reply before it.
 */
export function appendCutOffReply(messages: readonly VoiceMessage[], cutOff: string): VoiceMessage[] {
  const text = cutOff.trim()
  if (!text) return [...messages]
  return [...messages, { role: 'assistant', content: [{ type: 'text', text: `${text} ${CUT_OFF_NOTE}` }] }]
}

/**
 * Follows a reply that stopped at its token limit while the turn goes on (turn-engine.ts, v2): the words are being spoken
 * already, so the coach is asked to finish them and not to start again. It is a user message, and still part of the
 * coach's turn, not something the student said.
 */
export const FINISH_CUT_OFF_NOTE =
  '[Your reply reached its length limit and stopped there. The student has heard all of it, so do not repeat any of it. Finish the thought in one short sentence, and ask your one question if you had not asked it yet.]'

const isFinishNote = (message: VoiceMessage): boolean => message.role === 'user' && message.content === FINISH_CUT_OFF_NOTE

/** Said in the stored turn after what the student heard (draft copy, for the model only). */
export const INTERRUPTED_NOTE = '[The student interrupted here and did not hear the rest.]'
const NOTHING_HEARD_NOTE = '[The student interrupted before hearing any of this reply.]'

/** The most characters of heard text that are kept. */
export const MAX_HEARD_CHARS = 4000

function isToolResultMessage(message: VoiceMessage): boolean {
  return hasToolResult(message)
}

/**
 * The coach's last turn as the student heard it (spec 19.4). The browser says how much was spoken before the student
 * interrupted; the turn is stored as that text followed by a note, so the next model call sees only what was said and is not
 * led to think the student heard the rest. The turn is everything after the student's last words: the text of its
 * assistant messages is replaced, its tool calls and results stay so they still pair. A reply that was cut off and
 * finished in a second call is one reply to the student: the note between the two parts goes with the text it followed.
 * With nothing in the conversation to mark, or nothing said, the messages are returned as they are.
 */
export function markInterrupted(messages: readonly VoiceMessage[], heard: string): VoiceMessage[] {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && !isToolResultMessage(messages[i]) && !isFinishNote(messages[i])) {
      start = i
      break
    }
  }
  const turn = messages.slice(start + 1)
  const lastAssistant = (() => {
    for (let i = turn.length - 1; i >= 0; i -= 1) if (turn[i].role === 'assistant') return i
    return -1
  })()
  if (lastAssistant < 0) return [...messages]
  const spoken = heard.replace(/\s+/g, ' ').trim().slice(0, MAX_HEARD_CHARS)
  const text = spoken ? `${spoken} ${INTERRUPTED_NOTE}` : NOTHING_HEARD_NOTE
  const edited: VoiceMessage[] = []
  turn.forEach((message, index) => {
    if (message.role !== 'assistant') {
      if (!isFinishNote(message)) edited.push(message)
      return
    }
    const rest = blocksOf(message).filter((block) => block.type !== 'text')
    const content = index === lastAssistant ? [{ type: 'text', text }, ...rest] : rest
    if (content.length > 0) edited.push({ role: 'assistant', content })
  })
  return [...messages.slice(0, start + 1), ...edited]
}
