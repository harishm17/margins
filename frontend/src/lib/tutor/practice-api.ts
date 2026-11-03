/** The shapes the browser and POST /api/topics/[topicId]/practice-tutor share. */

import type { HelpAfterMiss } from '@/lib/learning/instruction-server'
import type { MissKind } from './state'

/**
 * One submission is one event on the tutor's ladder (spec §6.2):
 * - `check`: a checked answer (the server grades it itself); no model call.
 * - `hint`: an authored hint was opened; no model call.
 * - `ask`: "Ask about my working", or accepting the offer to talk it through.
 * - `clarify`: "What is this asking?", free of cost.
 * - `show_worked`: "Show me a worked example", which surrenders the step when the example is delivered.
 * - `dont_know`: the "I don't know" button (spec 18.3): the step's first check, wrong; no model call.
 * - `reveal`: "Show answer", which surrenders the step; no model call.
 * Connect, Structure, the worked example and Show answer need one attempt on the step: without it the route answers
 * 409 ATTEMPT_FIRST (spec 18.4).
 */
export type PracticeTutorEvent = 'check' | 'hint' | 'ask' | 'clarify' | 'show_worked' | 'dont_know' | 'reveal'

export type PracticeTutorBody = {
  problemIndex: number
  problemTitle: string
  stepIndex: number
  event: PracticeTutorEvent
  /** check: the answer the student gave. */
  answer?: string
  /** hint: 0 locate, 1 connect, 2 structure. */
  hintIndex?: 0 | 1 | 2
  /** ask, clarify, show_worked: everything the student has written about the step so far (the tutor reads it all). */
  working?: string
  /** ask: the latest thing they wrote. It is the event: only reasoning in it unlocks a rung. Absent, the working is it. */
  message?: string
  /** The answers the student has checked on this step, oldest first. */
  attempts?: string[]
  /** What the previous tutor reply classified the last miss as. */
  missKind?: MissKind
}

export type PracticeTutorState = {
  rung: number
  maxRung: number
  /** Genuine attempts so far: wrong checks and working with reasoning. */
  attempts: number
  /** What the server saw of the checked answers: all, wrong, and whether the right one was given. */
  checks: number
  wrongChecks: number
  checkedCorrect: boolean
  /** "Show me a worked example" may be used: at least one genuine attempt. */
  workedAllowed: boolean
  /** True once, on the attempt that makes the third failed one. */
  offerWorked: boolean
  /** Three low-effort turns in a row: the reply asks what is unclear. */
  askWhatIsUnclear: boolean
  /** The student said "I don't know" on this step: it is a failed first try whatever follows. */
  dontKnow: boolean
}

export type PracticeTutorResponse = {
  state: PracticeTutorState
  /** check: whether the answer was right. */
  correct?: boolean
  reply?: { text: string; rungUsed: number; located: boolean; missKind: MissKind | null }
  /** show_worked, reveal: the step was surrendered (it is recorded, and returns in fresh form). */
  surrendered?: boolean
  /** check (wrong) and dont_know: what to read now (spec 18.3), from stored claims, so it works with the AI down. */
  help?: HelpAfterMiss
}
