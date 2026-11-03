/**
 * The instruction-after-failure loop (spec 18.5), the pure half. Miss, then instruction, then a fresh retrieval later.
 * Replay derives `lastFailAt` and `lastInstructionAt` (memory.ts); this decides from them whether a concept is waiting
 * for instruction, and builds the event that records it. The database half is instruction-server.ts.
 */

import type { InstructionKind, ItemAnswerInput } from './evidence-types'
import { localDateParts } from './study-plan-time'

/**
 * A concept needs instruction when its latest retrieval failed (an Again group, or an IDK) and nothing has shown the idea
 * since: no page pointer opened, no explainer, no delivered worked example, no revealed answer.
 */
export function needsInstruction(derived: { lastFailAt: Date | null; lastInstructionAt: Date | null }): boolean {
  if (derived.lastFailAt === null) return false
  return derived.lastInstructionAt === null || derived.lastInstructionAt.getTime() < derived.lastFailAt.getTime()
}

const localDay = (at: Date, timeZone: string): string => {
  const { year, month, day } = localDateParts(at, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The evidence event of one instruction (spec 18.2): the student was shown the idea itself. It is a rule-graded
 * level-3 event with score 0, `source = 'instruction'` and `itemKey = instruction:<kind>:<ref>`. The writer
 * (`recordEvidence`) forces its weight to 0 and gives it no primary/secondary split; replay reads it only for
 * `lastInstructionAt`, so it never changes a card, q, `nAssisted` or a due date, and every reader that counts
 * answers excludes it.
 *
 * The session key holds the local day, so the same instruction shown twice in a day is one event
 * (`recordInstruction` writes it with `skipIfPresent`).
 */
export function instructionInput(
  kind: InstructionKind,
  input: { userId: string; projectId: string; topicId: string | null; conceptIds: string[]; ref: string; at: Date; timeZone?: string }
): ItemAnswerInput {
  const itemKey = `instruction:${kind}:${input.ref}`
  return {
    userId: input.userId,
    projectId: input.projectId,
    topicId: input.topicId,
    itemKey,
    conceptIds: input.conceptIds,
    source: 'instruction',
    score: 0,
    assistance: 3,
    gradedBy: 'rule',
    sessionKey: `${itemKey}:${localDay(input.at, input.timeZone ?? 'UTC')}`,
    metadata: { kind },
    at: input.at,
  }
}
