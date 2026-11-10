/**
 * Running the step a session is waiting for before the model speaks (spec §19.1).
 *
 * A graded student utterance used to cost two model calls in series: the first only asked for a tool, the second spoke.
 * Now the server decides by rule (utterance.ts) what the utterance is and, for an answer, runs the step the session is
 * waiting for with the same code and the same gates as the tool: oral quiz `record_answer`, teach-back
 * `assess_explanation` (or `record_check` for the new example), guided reading `next_claim` with reveal (the prediction)
 * and `record_check`. The result goes to the one model call as tagged data, `<app_result step="...">`, after the
 * student's words. The tool stays in the model's hands for every case the rules did not cover.
 *
 * Nothing about the steps changes: the "student has spoken" gate, the probes before an explanation, the claim withheld
 * until the explain step, the grading allowance and the evidence are all in the step code, so a pre-run cannot skip one.
 * Where the rules cannot be sure the step is the right one, no step runs and the model decides as before:
 *   - not English (the rules read English phrases);
 *   - a quiz question that asks for the student's confidence first (the confidence is the model's argument);
 *   - a quiz question that already has an answer (a reply to the feedback, such as the "Why?" follow-up);
 *   - a hint, an ask for the answer, a repeat request, a question back, an acknowledgement or a control word;
 *   - a very short teach-back reply (under three words) that is not an "I don't know";
 *   - a retry of a turn whose pre-run result is already in the stored conversation.
 */
import type { CoachStyle } from '@/lib/voice/coach-prompt'
import type { VoiceBlock, VoiceMessage } from '@/lib/voice/history'
import { heardSince, type CoachState } from '@/lib/voice/teach-tools'
import { classifyUtterance, hasSubstance, type UtteranceKind } from '@/lib/voice/utterance'
import type { VoiceStreamExtra } from '@/lib/voice/turn-contract'

export type PreRunStep = Extract<VoiceStreamExtra, { type: 'working' }>['step']

export type PreRunPlan = {
  /** The name sent to the browser (`working` event). */
  step: PreRunStep
  /** The tool whose code runs, and its arguments. */
  tool: 'record_answer' | 'assess_explanation' | 'next_claim' | 'record_check'
  input: Record<string, unknown>
  /** A guided-reading reveal asks the server's own check question (the coach has not chosen one). */
  autoCheck?: boolean
}

export type PreRunFacts = {
  style: CoachStyle
  language: string
  utterance: string
  /** The coach state after this turn's utterance was stored (`beginVoiceTurn`). */
  state: CoachState
  /** Oral quiz: the question put last already has an answer recorded. */
  currentAnswered: boolean
  /** What the coach said last, as the student heard it: the question of a new example is those words. */
  lastCoachText: string
}

/** Every third question (index 2, 5, 8) asks "How sure are you?" before it is recorded; see the quiz rules in coach-prompt.ts. */
export const asksConfidence = (questionIndex: number): boolean => questionIndex % 3 === 2

const isEnglish = (language: string) => /^en(\b|-|_|$)/i.test(language.trim()) || language.trim() === ''

/** The step to run before the model speaks, or null when the model should decide (see the file comment). */
export function planPreRun(facts: PreRunFacts): PreRunPlan | null {
  const { style, state, utterance } = facts
  if (!isEnglish(facts.language) || !utterance.trim()) return null
  const kind: UtteranceKind = classifyUtterance(utterance)
  if (kind !== 'answer' && kind !== 'idk') return null

  if (style === 'oral_quiz') {
    const index = state.quiz.current
    if (index < 0 || state.quiz.askedTurn < 0 || facts.currentAnswered) return null
    // An "I don't know" has no confidence to ask for; any other answer to such a question waits for the coach's extra question.
    if (kind !== 'idk' && asksConfidence(index)) return null
    if (!heardSince(state, state.quiz.askedTurn).trim()) return null
    return { step: 'record_answer', tool: 'record_answer', input: { question_index: index, ...(kind === 'idk' ? { idk: true } : {}) } }
  }

  if (style === 'teach_back') {
    const conceptId = state.teach.current
    const concept = conceptId ? state.teach.concepts[conceptId] : undefined
    if (!conceptId || !concept || concept.outcome || state.teach.askedTurn < 0) return null
    if (!hasSubstance(utterance, kind)) return null
    if (!heardSince(state, state.teach.askedTurn).trim()) return null
    if (concept.exampleAsked) {
      const question = facts.lastCoachText.trim().slice(0, 1000)
      return question ? { step: 'record_check', tool: 'record_check', input: { concept_id: conceptId, question } } : null
    }
    return { step: 'assess', tool: 'assess_explanation', input: { concept_id: conceptId } }
  }

  if (style === 'guided_reading') {
    const guided = state.guided
    if (guided.askedTurn < 0 || !heardSince(state, guided.askedTurn).trim()) return null
    // The prediction: "no idea" is an honest one, so an "I don't know" reveals the claim too.
    if (guided.stage === 'predicting') return { step: 'reveal', tool: 'next_claim', input: { reveal: true }, autoCheck: true }
    if (guided.stage === 'taught' && guided.checkQuestion) {
      return { step: 'record_check', tool: 'record_check', input: { claim_index: guided.index, ...(kind === 'idk' ? { idk: true } : {}) } }
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------- the model's side

/** Keeps a result from closing its own tag. */
const safe = (json: string) => json.replace(/<\/app_result/gi, '<\\/app_result')

/**
 * The student's words with any `<app_result` or `</app_result` tag defused, so speech cannot pass for a result from the
 * app (prompt audit L3). Used only with PROMPTS_V2 on.
 */
export const neutralizeAppResultTags = (text: string): string => text.replace(/<(\/?app_result)/gi, '&lt;$1')

/** The text block that carries a step's result to the model, after the student's words. */
export function appResultBlock(tool: PreRunPlan['tool'], output: Record<string, unknown>): VoiceBlock {
  return { type: 'text', text: `<app_result step="${tool}">${safe(JSON.stringify(output))}</app_result>` }
}

const APP_RESULT = /<app_result step="/

const textOfBlocks = (message: VoiceMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')

/**
 * True when the stored conversation ends with a student message that already carries a result: the turn failed after its
 * step ran, and this is the student trying again. The step is not run twice; the model answers with the result it has.
 */
export function endsWithAppResult(history: readonly VoiceMessage[]): boolean {
  const last = history[history.length - 1]
  return !!last && last.role === 'user' && APP_RESULT.test(textOfBlocks(last))
}

/** The student's message with the step's result added after their words. */
export function withAppResult(messages: readonly VoiceMessage[], block: VoiceBlock): VoiceMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return [...messages]
  const blocks: VoiceBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
  return [...messages.slice(0, -1), { role: 'user', content: [...blocks, block] }]
}

/** What the coach said last: the text of the last assistant message, without the note of an interruption. */
export function lastCoachText(history: readonly VoiceMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'assistant') return textOfBlocks(history[i]).replace(/\s*\[The student interrupted[^\]]*\]\s*$/, '').trim()
  }
  return ''
}
