/**
 * What the session waits for after a coach turn (spec §19.2): the browser sets its end-of-turn wait from it, since a short
 * answer, a prediction and an explanation are given at different speeds. Sent as the `listen` event with the end of the turn.
 */
import { prisma } from '@/lib/db/prisma'
import { coachStyleOf, type CoachStyle } from '@/lib/voice/coach-prompt'
import { readCoachState, type CoachState } from '@/lib/voice/teach-tools'
import type { ListenFor } from '@/lib/voice/turn-contract'

/** Pure: the wait for a session in this state. `ended` is a drill that has finished (nothing more is said). */
export function listenFor(style: CoachStyle, state: CoachState, ended: boolean): ListenFor {
  if (ended) return 'none'
  switch (style) {
    case 'oral_quiz':
    case 'topic_conversation':
      return 'short_answer'
    case 'teach_back': {
      const concept = state.teach.current ? state.teach.concepts[state.teach.current] : undefined
      // The new example is a prediction about a case the coach chose; the explanation and the answers to probes are explanations.
      return concept && !concept.outcome && concept.exampleAsked ? 'prediction' : 'explanation'
    }
    case 'guided_reading':
      return state.guided.stage === 'predicting' ? 'prediction' : 'short_answer'
  }
}

/** The wait for the session as it is now, after the turn's tools have written their state. */
export async function listenForSession(userId: string, sessionId: string): Promise<ListenFor> {
  const session = await prisma.voiceDrillSession.findFirst({ where: { id: sessionId, userId }, select: { style: true, coachState: true, endedAt: true } })
  if (!session) return 'short_answer'
  return listenFor(coachStyleOf(session.style), readCoachState(session.coachState), session.endedAt !== null)
}
