/**
 * The check question that ends an Ask explanation (spec §6.3, §3.3). Server only.
 *
 * The card is stored with the reply that asked it, answer included, and the browser is only given the question.
 * The student answers from memory with how sure they are, asks to see the answer, and grades themselves: Got it,
 * Partly or Missed. That is level 2 (`source=ask_check`), graded by the student, for display: it never moves the
 * memory. A card is graded once; the first grade stands.
 */

import { prisma } from '@/lib/db/prisma'
import { confidenceValue, type ConfidenceId } from '@/lib/learning/calibration'
import { recordEvidence } from '@/lib/learning/evidence'
import { itemKey } from '@/lib/learning/item-key'
import { checkScore, type CheckGrade } from '@/lib/reader/checks'
import { ownedMessage } from '@/server/owned'
import { parseStoredTutor } from './tutor-message'

/** The assistant message with a card, if it is this student's. */
async function ownedCard(userId: string, messageId: string) {
  const message = await ownedMessage(userId, messageId, 'assistant')
  const check = parseStoredTutor(message?.tutor)?.check
  return message && check ? { message, check } : null
}

/**
 * The answer and explanation, asked for when the student shows them (they are not sent with the reply). The
 * server returns them only once it holds the student's attempt: their words, or "I don't know" (spec P1). An
 * attempt sent with the call is stored (the first one stands); without one, an attempt stored earlier is enough
 * (a page reload). `attempt_required` when there is none.
 */
export type RevealResult = { status: 'ok'; answer: string; explanation: string } | { status: 'not_found' } | { status: 'attempt_required' }

export async function revealAskCheck(input: { userId: string; messageId: string; attempt?: string; dontKnow?: boolean }): Promise<RevealResult> {
  const found = await ownedCard(input.userId, input.messageId)
  if (!found) return { status: 'not_found' }
  let attempt = found.check.attempt
  const text = (input.attempt ?? '').trim()
  if (!attempt && (text || input.dontKnow)) {
    const stored = JSON.stringify({ text, idk: !text })
    // The first attempt stands: a card cannot be re-attempted against an answer already shown.
    await prisma.$executeRaw`
      UPDATE chat_messages
      SET tutor = jsonb_set(tutor, '{check,attempt}', ${stored}::jsonb)
      WHERE id = ${input.messageId} AND tutor -> 'check' IS NOT NULL AND (tutor -> 'check' ->> 'attempt') IS NULL`
    attempt = { text, idk: !text }
  }
  if (!attempt) return { status: 'attempt_required' }
  return { status: 'ok', answer: found.check.answer, explanation: found.check.explanation }
}

/** `grade` is the grade that stands: "I don't know" is a Missed whatever was tapped. */
export type AskCheckResult = { status: 'ok'; recorded: boolean; grade: CheckGrade } | { status: 'not_found' } | { status: 'attempt_required' }

export async function recordAskCheck(input: {
  userId: string
  messageId: string
  grade: CheckGrade
  confidenceLevel?: ConfidenceId
  dontKnow?: boolean
  timeZone: string
}): Promise<AskCheckResult> {
  const { userId, messageId } = input
  // Saying "I don't know" and then grading the answer Got it is a contradiction: it counts as Missed.
  const grade: CheckGrade = input.dontKnow ? 'missed' : input.grade
  const found = await ownedCard(userId, messageId)
  if (!found) return { status: 'not_found' }
  const { message, check } = found
  // A grade is of an answer the student gave: no stored attempt, no grade and no evidence.
  if (!check.attempt) return { status: 'attempt_required' }

  // The first grade stands. The claim is one conditional write, so two taps at once record one grade.
  const claimed = await prisma.$executeRaw`
    UPDATE chat_messages
    SET tutor = jsonb_set(tutor, '{check,grade}', to_jsonb(${grade}::text))
    WHERE id = ${messageId} AND tutor -> 'check' IS NOT NULL AND (tutor -> 'check' ->> 'grade') IS NULL`
  if (claimed === 0) return { status: 'ok', recorded: false, grade }

  try {
    // A card that names no concept of the course (or one that has since gone) is graded but not filed.
    const concept = check.conceptId
      ? await prisma.concept.findFirst({
          where: { id: check.conceptId, projectId: message.projectId, status: 'active', project: { userId } },
          select: { id: true, topicId: true },
        })
      : null
    if (!concept) return { status: 'ok', recorded: false, grade }
    await recordEvidence(
      [
        {
          userId,
          projectId: message.projectId,
          topicId: concept.topicId,
          itemKey: itemKey({ kind: 'ask', threadId: message.threadId, messageId }),
          conceptIds: [concept.id],
          source: 'ask_check',
          score: checkScore(grade),
          assistance: 2,
          gradedBy: 'self',
          ...(input.confidenceLevel ? { confidence: confidenceValue(input.confidenceLevel) } : {}),
          sessionKey: `ask-check:${messageId}`,
          metadata: { grade, ...(input.confidenceLevel ? { confidenceLevel: input.confidenceLevel } : {}), ...(input.dontKnow ? { idk: true } : {}) },
        },
      ],
      { timeZone: input.timeZone, userId, skipIfPresent: true }
    )
    // The grade is the student's own, so it never tells the tutor they hold a right answer (spec 6.2): the
    // thread's `checkedCorrect` is not set from it.
    return { status: 'ok', recorded: true, grade }
  } catch (error) {
    // Nothing was filed, so the card can be graded again.
    await prisma.$executeRaw`UPDATE chat_messages SET tutor = tutor #- '{check,grade}' WHERE id = ${messageId}`.catch(() => undefined)
    throw error
  }
}

/** What the API says to a grade or a reveal that comes before the student's attempt. */
export const ANSWER_FIRST = "Answer the question first, or say you don't know."
