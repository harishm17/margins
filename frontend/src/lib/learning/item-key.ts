import type { ConceptEvent, ItemAnswerInput } from './evidence-types'

export type ItemRef =
  | { kind: 'quiz'; setId: string; index: number }
  | { kind: 'exam'; examId: string; index: number }
  | { kind: 'practice'; contentId: string; problem: number; step: number }
  | { kind: 'recall'; topicId: string; objective: number | 'all' }
  | { kind: 'teach_back'; topicId: string; conceptId: string | 'all' }
  | { kind: 'review'; sessionId: string; index: number }
  | { kind: 'voice'; sessionId: string; index: number }
  | { kind: 'ask'; threadId: string; messageId: string }

export function itemKey(ref: ItemRef): string {
  switch (ref.kind) {
    case 'quiz':
      return `quiz:${ref.setId}:${ref.index}`
    case 'exam':
      return `exam:${ref.examId}:${ref.index}`
    case 'practice':
      return `practice:${ref.contentId}:${ref.problem}:${ref.step}`
    case 'recall':
      return `recall:${ref.topicId}:${ref.objective}`
    case 'teach_back':
      return `teach_back:${ref.topicId}:${ref.conceptId}`
    case 'review':
      return `review:${ref.sessionId}:${ref.index}`
    case 'voice':
      return `voice:${ref.sessionId}:${ref.index}`
    case 'ask':
      return `ask:${ref.threadId}:${ref.messageId}`
  }
}

const SECONDARY_WEIGHT = 0.5
const FAILURE_OTHER_WEIGHT = 0.25
const MODEL_GRADER_WEIGHT = 0.7

// Splits one item answer into one event per concept (spec §3.4 step 1).
// The first concept is primary. On a failure (score < 0.5) the blamed concept,
// or the primary when none is named, takes weight 1 and the others 0.25.
export function expandToConceptEvents(input: ItemAnswerInput): ConceptEvent[] {
  const ids = [...new Set(input.conceptIds)]
  if (ids.length === 0) return []
  // An instruction event (spec 18.5) shows the idea; it is not an answer. One event per concept, weight 0, no
  // primary/secondary split and no blamed concept: replay reads it only for lastInstructionAt.
  if (input.source === 'instruction') {
    const createdAt = input.at ?? new Date()
    return ids.map((conceptId) => ({
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      conceptId,
      itemKey: input.itemKey,
      role: 'primary' as const,
      source: input.source,
      score: 0,
      assistance: 3 as const,
      confidence: null,
      weight: 0,
      gradedBy: input.gradedBy,
      latencyMs: null,
      sessionKey: input.sessionKey,
      metadata: input.metadata ?? {},
      createdAt,
    }))
  }
  const failed = input.score < 0.5
  const blamed =
    input.blamedConceptId && ids.includes(input.blamedConceptId)
      ? input.blamedConceptId
      : ids[0]
  const graderWeight = input.gradedBy === 'model' ? MODEL_GRADER_WEIGHT : 1
  const createdAt = input.at ?? new Date()

  return ids.map((conceptId, i) => {
    const role = i === 0 ? 'primary' : 'secondary'
    const roleWeight = failed
      ? conceptId === blamed
        ? 1
        : FAILURE_OTHER_WEIGHT
      : role === 'primary'
        ? 1
        : SECONDARY_WEIGHT
    return {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      conceptId,
      itemKey: input.itemKey,
      role,
      source: input.source,
      score: input.score,
      assistance: input.assistance,
      confidence: input.confidence ?? null,
      weight: roleWeight * graderWeight,
      gradedBy: input.gradedBy,
      latencyMs: input.latencyMs ?? null,
      sessionKey: input.sessionKey,
      metadata: input.metadata ?? {},
      createdAt,
    }
  })
}
