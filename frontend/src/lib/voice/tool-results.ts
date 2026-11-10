/**
 * What each voice tool returns to the model, as types, and the list of top-level result keys per tool (prompt audit R6).
 *
 * The handlers build their results against these types, and `resultKeys` fails to compile when a key list leaves out a
 * key of the type, so the list cannot fall behind the code. The v2 tool descriptions (tools.ts) are checked against
 * the lists by tool-contract.test.ts: every key of every result, errors included, is named in the description.
 */

type AllKeys<T> = T extends unknown ? keyof T : never

/** Lists the keys of a result type; a key missing from the list, or one the type does not have, is a compile error. */
function resultKeys<T>() {
  return <const K extends readonly AllKeys<T>[]>(keys: K & ([Exclude<AllKeys<T>, K[number]>] extends [never] ? unknown : never)): K => keys
}

/** A tool that could not do its job. The text is a message for the model, or one of the codes the descriptions name. */
export type ErrorResult = { error: string }
/** The drill, or the list of ideas or claims, is finished. */
export type DoneResult = { done: true; message: string }

export type NextQuestionResult =
  | ErrorResult
  | DoneResult
  | {
      done: false
      question_index: number
      question: { question_text: string; question_type: string; options: unknown[]; concepts_tested: string[] }
      ask_confidence_first?: boolean
      ask_why_if_right?: boolean
    }

export type RecordAnswerResult =
  | ErrorResult
  | DoneResult
  | {
      is_correct: boolean
      score: number
      feedback: { comment: string; explanation: string; ungraded?: boolean }
      where_to_look?: string[]
    }

export type HintResult =
  | ErrorResult
  | { action: 'ask_for_try'; instruction: string }
  | { hint: string; ideas_expected?: number; concepts: string[]; note: string }

export type ConceptToExplainResult =
  | ErrorResult
  | DoneResult
  | { done: false; concept_id: string; concept_name: string; prompt: string; ideas_left: number }

export type ClarifyResult = { action: 'clarify'; clarifying_question: string; instruction: string }

/** What the student said, claim by claim (teach-tools.ts `findingsOutput`). */
export type FindingsFields = {
  covered: { you_said: string | null }[]
  partly: { you_said: string | null }[]
  incorrect: { you_said: string | null; wrong_idea: string | null; page: number | null }[]
  missing: { pointer: string | null }[]
}

/** What the coach does next (teach-tools.ts `planOutput`). */
export type PlanFields =
  | {
      action: 'probe'
      probe: { type: string; finding: string; number: number; example: string; about?: string; page?: number }
    }
  | { action: 'explain' | 'explain_first'; source_claim: { text: string; page: number | null }; instruction: string }
  | { action: 'ask_new_example'; instruction: string }
  | { action: 'wrap_up' }

type Closing = { outcome?: string | null; look_again?: string[] }

export type AssessExplanationResult = ErrorResult | DoneResult | ClarifyResult | ({ concept: string } & FindingsFields & PlanFields & Closing)

export type ExampleCheckResult = ErrorResult | DoneResult | ClarifyResult | ({ concept: string; passed: boolean } & FindingsFields & PlanFields & Closing)

export type NextClaimResult =
  | ErrorResult
  | DoneResult
  | { done: false; claim_index: number; of: number; concept_name: string; claim: { text: string | null; page: number | null }; instruction: string }
  | { done: false; claim_index: number; of: number; concept_name: string; prediction_prompt: string; instruction: string }

export type ClaimCheckResult =
  | ErrorResult
  | DoneResult
  | ClarifyResult
  | {
      verdict: string
      you_said?: string | null
      wrong_idea?: string | null
      claim: { text: string | null; page: number | null }
      claims_left: number
      instruction: string
    }

/** The tool names of the v2 lists. `record_check` is split in two so no two tools in a style share a name. */
export type V2ToolName =
  | 'get_next_question'
  | 'record_answer'
  | 'get_hint'
  | 'get_concept_to_explain'
  | 'assess_explanation'
  | 'record_example_check'
  | 'next_claim'
  | 'record_claim_check'

const FINDINGS = ['covered', 'partly', 'incorrect', 'missing'] as const

export const TOOL_RESULT_KEYS = {
  get_next_question: resultKeys<NextQuestionResult>()(['error', 'done', 'message', 'question_index', 'question', 'ask_confidence_first', 'ask_why_if_right']),
  record_answer: resultKeys<RecordAnswerResult>()(['error', 'done', 'message', 'is_correct', 'score', 'feedback', 'where_to_look']),
  get_hint: resultKeys<HintResult>()(['error', 'action', 'instruction', 'hint', 'ideas_expected', 'concepts', 'note']),
  get_concept_to_explain: resultKeys<ConceptToExplainResult>()(['error', 'done', 'message', 'concept_id', 'concept_name', 'prompt', 'ideas_left']),
  assess_explanation: resultKeys<AssessExplanationResult>()([
    'error', 'done', 'message', 'action', 'clarifying_question', 'instruction', 'concept', ...FINDINGS, 'probe', 'source_claim', 'outcome', 'look_again',
  ]),
  record_example_check: resultKeys<ExampleCheckResult>()([
    'error', 'done', 'message', 'action', 'clarifying_question', 'instruction', 'concept', 'passed', ...FINDINGS, 'probe', 'source_claim', 'outcome', 'look_again',
  ]),
  next_claim: resultKeys<NextClaimResult>()(['error', 'done', 'message', 'claim_index', 'of', 'concept_name', 'claim', 'prediction_prompt', 'instruction']),
  record_claim_check: resultKeys<ClaimCheckResult>()([
    'error', 'done', 'message', 'action', 'clarifying_question', 'instruction', 'verdict', 'you_said', 'wrong_idea', 'claim', 'claims_left',
  ]),
} satisfies Record<V2ToolName, readonly string[]>

/** The values of `error` that name a missing current item (the descriptions name them). */
export const NO_CURRENT = {
  question: 'no_current_question',
  concept: 'no_current_concept',
  claim: 'no_current_claim',
} as const
