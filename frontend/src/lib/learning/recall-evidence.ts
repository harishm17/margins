import type { ItemAnswerInput } from './evidence-types'
import { dontKnowEvidence } from './dont-know'
import type { ConceptRecallScore } from './recall-scores'

/**
 * The evidence a recall answer writes (spec §3.3, §5.3). One event per concept, each with its own score.
 *
 * - Level 0, `source=recall` (`teach_back` for an explanation of one concept), graded by the model: the
 *   model-graded weight of 0.7 is applied when the events are expanded (item-key.ts). Level 0 with a score of
 *   0.75 or more on a recall or teach-back is what opens the judgment gate (`explainedWell`, memory.ts).
 * - The reader or the explainer was opened while the card was open: the answer was not given with the book
 *   closed, so it is level 2 (shown, never a memory review).
 * - An answer to a card on the same local day after its feedback was seen is assisted (spec §3.3, "first attempt"):
 *   level 2 when it succeeds, a level-1 failure (score 0) when it does not, and level 3 when the card's missed
 *   claims were revealed. A later day is a fresh level-0 retrieval. The server decides this from the stored attempts.
 * - "I don't remember" (spec 18.3) is a failed first try: level 1, score 0, written by `recallIdkEvidence` through the
 *   shared IDK contract (no confidence, no misconception, `cue_miss`). It is level 1 whatever else is set.
 * - `missKind` and `misconception` ride in the metadata, where the learner model reads them.
 */

export type RecallRepeat = 'seen' | 'revealed'

export type RecallEvidenceInput = {
  userId: string
  projectId: string
  topicId: string
  kind: 'recall' | 'teach_back'
  itemKey: string
  attemptId: string
  abandoned: boolean
  /** The card was already answered today (the student's day) and its feedback seen, or its missed claims shown. */
  repeat?: RecallRepeat | null
  scores: ConceptRecallScore[]
  at?: Date
}

const PASS = 0.75

/** The level an answer is recorded at, and the score kept with it. */
export function recallLevel(input: Pick<RecallEvidenceInput, 'abandoned' | 'repeat'> & { idk?: boolean }, score: number): { assistance: 0 | 1 | 2 | 3; score: number } {
  if (input.idk) return { assistance: 1, score: 0 }
  if (input.repeat === 'revealed') return { assistance: 3, score: 0 }
  if (input.abandoned) return { assistance: 2, score }
  if (input.repeat === 'seen') return score >= PASS ? { assistance: 2, score } : { assistance: 1, score: 0 }
  return { assistance: 0, score }
}

export function recallEvidence(input: RecallEvidenceInput): ItemAnswerInput[] {
  return input.scores.map((concept) => {
    const level = recallLevel(input, concept.score)
    return {
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      itemKey: input.itemKey,
      conceptIds: [concept.conceptId],
      source: input.kind,
      score: level.score,
      assistance: level.assistance,
      gradedBy: 'model',
      sessionKey: `recall:${input.attemptId}`,
      at: input.at,
      metadata: {
        mode: 'recall',
        attemptId: input.attemptId,
        ...(input.abandoned ? { abandoned: true } : {}),
        ...(input.repeat ? { repeat: input.repeat } : {}),
        ...(concept.missKind ? { missKind: concept.missKind } : {}),
        ...(concept.misconception ? { misconception: concept.misconception } : {}),
      },
    }
  })
}

/** "I don't remember": one level-1, score-0 event on each concept of the card (spec 18.3). */
export function recallIdkEvidence(input: Omit<RecallEvidenceInput, 'scores' | 'abandoned' | 'repeat'> & { conceptIds: string[] }): ItemAnswerInput[] {
  return [...new Set(input.conceptIds)].flatMap((conceptId) =>
    dontKnowEvidence({
      userId: input.userId,
      projectId: input.projectId,
      topicId: input.topicId,
      itemKey: input.itemKey,
      conceptIds: [conceptId],
      surface: input.kind,
      level: 1,
      sessionKey: `recall:${input.attemptId}`,
      at: input.at,
      metadata: { mode: 'recall', attemptId: input.attemptId },
    })
  )
}

/**
 * "Show me what I missed": the claims were shown, so the concepts they belong to carry level 3 (the app told
 * the student; no memory review, no score, and a card that exists comes due by tomorrow).
 */
export function revealEvidence(input: Omit<RecallEvidenceInput, 'scores' | 'abandoned' | 'repeat'> & { conceptIds: string[] }): ItemAnswerInput[] {
  return [...new Set(input.conceptIds)].map((conceptId) => ({
    userId: input.userId,
    projectId: input.projectId,
    topicId: input.topicId,
    itemKey: `${input.itemKey}:reveal`,
    conceptIds: [conceptId],
    source: input.kind,
    score: 0,
    assistance: 3,
    gradedBy: 'rule',
    sessionKey: `recall-reveal:${input.attemptId}`,
    at: input.at,
    metadata: { revealed: true, attemptId: input.attemptId },
  }))
}
