/**
 * The database side of running a step before the model speaks (spec §19.1): reading what the session is waiting for,
 * and running the step through the same `executeVoiceTool` the model's tool call goes through. The rules are in pre-run.ts.
 */
import { prisma } from '@/lib/db/prisma'
import { coachStyleOf } from '@/lib/voice/coach-prompt'
import type { VoiceBlock, VoiceMessage } from '@/lib/voice/history'
import { appResultBlock, endsWithAppResult, lastCoachText, planPreRun, withAppResult, type PreRunPlan } from '@/lib/voice/pre-run'
import { readCoachState } from '@/lib/voice/teach-tools'
import { executeVoiceTool, type VoiceToolResult } from '@/lib/voice/tools'
import type { VoiceEvent } from '@/lib/voice/turn-client'
import type { VoiceStreamExtra } from '@/lib/voice/turn-contract'

/**
 * The step to run for this utterance, or null. Read after `beginVoiceTurn` stored the utterance, from the session as it is now
 * (not the row the route loaded before the turn began).
 */
export async function planPreRunForSession(input: {
  userId: string
  sessionId: string
  language: string
  utterance: string
  history: readonly VoiceMessage[]
}): Promise<PreRunPlan | null> {
  if (!input.utterance.trim() || endsWithAppResult(input.history)) return null
  const session = await prisma.voiceDrillSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { style: true, coachState: true, endedAt: true },
  })
  if (!session || session.endedAt) return null
  const style = coachStyleOf(session.style)
  const state = readCoachState(session.coachState)
  const currentAnswered =
    style === 'oral_quiz' && state.quiz.current >= 0
      ? (await prisma.voiceDrillAttempt.count({ where: { sessionId: input.sessionId, questionIndex: state.quiz.current } })) > 0
      : false
  return planPreRun({ style, language: input.language, utterance: input.utterance, state, currentAnswered, lastCoachText: lastCoachText(input.history) })
}

export type PreRunOutcome = { result: VoiceToolResult; block: VoiceBlock }

/** Runs the planned step. A step that throws is reported to the model as a failed tool, like the turn loop does. */
export async function runPreRun(
  plan: PreRunPlan,
  ctx: { sessionId: string; userId: string; timeZone: string; turn: number; steps: import('@/lib/voice/tools').StepCache; grade?: Parameters<typeof executeVoiceTool>[0]['grade'] },
  log: (message: string, error?: unknown) => void = (message, error) => console.error(`[VOICE] ${message}`, error ?? '')
): Promise<PreRunOutcome> {
  let result: VoiceToolResult
  try {
    result = await executeVoiceTool({ ...ctx, autoCheck: plan.autoCheck }, plan.tool, plan.input)
  } catch (error) {
    log(`Pre-run step ${plan.tool} failed`, error)
    result = { output: { error: 'The step failed. Tell the student and carry on.' }, events: [], sessionComplete: false, isError: true }
  }
  return { result, block: appResultBlock(plan.tool, result.output) }
}

/**
 * The start of a turn with a planned step: tells the browser a graded step has begun, runs it, sends its events, and returns
 * the student's message with the result added, for the one model call.
 */
export async function startWithPreRun(
  plan: PreRunPlan,
  ctx: Parameters<typeof runPreRun>[1],
  messages: readonly VoiceMessage[],
  emit: (event: VoiceEvent | VoiceStreamExtra) => void
): Promise<{ messages: VoiceMessage[]; result: VoiceToolResult }> {
  emit({ type: 'working', step: plan.step })
  const ran = await runPreRun(plan, ctx)
  for (const event of ran.result.events) emit(event)
  return { messages: withAppResult(messages, ran.block), result: ran.result }
}
