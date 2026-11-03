import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { GradedQuestion } from '@/lib/ai-service/grading'
import type { ItemAnswerInput } from './evidence-types'
import { recordEvidence } from './evidence'
import { itemKey } from './item-key'
import { isAnswered, type QuizAnswer } from './quiz-answers'
import { dontKnowEvidence } from './dont-know'
import { studentTimeZone } from './student-time-zone'
import { dueForEvidenceRetry, logIfGivenUp } from './evidence-retry-budget'
import { localDateParts } from './study-plan-time'

type RawQuestion = Record<string, unknown>

const MODES = ['recall', 'discrimination', 'composition']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** The option a student picked on a multiple-choice question, when it is one of the question's options. */
function pickedOption(question: RawQuestion, answer: string): Record<string, unknown> | null {
  if (!Array.isArray(question.options)) return null
  const id = answer.trim().toUpperCase()
  return question.options.filter(isRecord).find((option) => String(option.id).trim().toUpperCase() === id) ?? null
}

/** What differs between a quiz and an exam when graded answers become evidence. */
export type EvidenceTarget = {
  userId: string
  projectId: string
  source: 'quiz' | 'exam' | 'review' | 'drill' | 'warmup'
  sessionKey: string
  itemKeyOf: (index: number) => string
  /** The topic a question's evidence is filed under; a question may belong to another topic than its neighbours (an exam). */
  topicOf: (index: number) => string | null
}

/**
 * One piece of evidence per answered, graded question that names concepts (spec §3.4, §5.7): level 0,
 * source quiz, the session key being the attempt. Questions without `concept_ids` (a quiz from before
 * the concept graph, or a topic whose extraction has not run) write nothing, and unanswered ones are
 * not retrievals. A wrong choice names its wrong idea through the option it picked, with no model
 * call; a wrong short answer carries the grader's blamed concept and misconception.
 */
export function buildQuizEvidence(input: {
  userId: string
  projectId: string
  topicId: string
  quizSetId: string | null
  attemptId: string
  questions: RawQuestion[]
  answers: Record<string, QuizAnswer>
  graded: GradedQuestion[]
  /** Concept ids that exist and are active; anything else on a question is ignored. */
  knownConceptIds?: Set<string>
  at?: Date
  /** The same set was already taken earlier the same local day: the student has just seen these answers, so level 2 (spec 7.3). */
  sameDayRepeat?: boolean
  /** Rule items were recorded already (the AI was down at submit): write only the events that are not there. */
  skipIfPresent?: boolean
}): ItemAnswerInput[] {
  return buildGradedEvidence(
    {
      userId: input.userId,
      projectId: input.projectId,
      source: 'quiz',
      sessionKey: `quiz:${input.attemptId}`,
      itemKeyOf: (index) => itemKey({ kind: 'quiz', setId: input.quizSetId ?? 'legacy', index }),
      topicOf: () => input.topicId,
    },
    input
  )
}

/** The shared core of quiz and exam evidence: the same rules for what counts and how a miss is named. */
export function buildGradedEvidence(
  target: EvidenceTarget,
  input: {
    questions: RawQuestion[]
    answers: Record<string, QuizAnswer>
    graded: GradedQuestion[]
    knownConceptIds?: Set<string>
    at?: Date
    sameDayRepeat?: boolean
  }
): ItemAnswerInput[] {
  const inputs: ItemAnswerInput[] = []
  for (const result of input.graded) {
    const index = result.question_index
    const question = input.questions[index]
    const given = input.answers[String(index)]
    if (!question || !given || !isAnswered(given)) continue
    const conceptIds = (Array.isArray(question.concept_ids) ? question.concept_ids : []).filter(
      (id): id is string => typeof id === 'string' && !!id && (!input.knownConceptIds || input.knownConceptIds.has(id))
    )
    if (conceptIds.length === 0 || !(result.points_possible > 0)) continue

    const score = Math.min(1, Math.max(0, result.points_earned / result.points_possible))
    const failed = score < 0.5
    const isShort = result.question_type === 'short_answer'
    const metadata: Record<string, unknown> = { questionType: result.question_type }
    if (typeof question.mode === 'string' && MODES.includes(question.mode)) metadata.mode = question.mode
    const level = input.sameDayRepeat ? 2 : 0
    if (input.sameDayRepeat) metadata.repeat = 'same_day'

    // "I don't know" is recorded as a wrong answer with no confidence and no misconception (spec 18.3). No help comes
    // mid-quiz, so it is level 0 (level 2 on a same-day repeat).
    if (given.idk) {
      const [idk] = dontKnowEvidence({
        userId: target.userId,
        projectId: target.projectId,
        topicId: target.topicOf(index),
        itemKey: target.itemKeyOf(index),
        conceptIds,
        surface: target.source,
        level,
        sessionKey: target.sessionKey,
        metadata,
        at: input.at,
      })
      inputs.push(idk)
      continue
    }

    // Only a concept that survived the filter above: a retired id would break the insert for the whole attempt.
    const named = nonEmpty(result.blamed_concept_id)
    let blamedConceptId = named && conceptIds.includes(named) ? named : undefined
    if (failed) {
      if (isShort) {
        const misconception = nonEmpty(result.misconception)
        if (misconception) {
          metadata.misconception = misconception
          metadata.missKind = 'misconception'
        }
      } else if (result.question_type === 'multiple_choice') {
        const picked = pickedOption(question, given.answer)
        const misconception = nonEmpty(picked?.misconception)
        if (misconception) {
          metadata.misconception = misconception
          // A wrong idea that is a mix-up with another concept is a discrimination miss (§6.2.1).
          const confusable = nonEmpty(picked?.confusable_concept_id)
          metadata.missKind = confusable ? 'discrimination' : 'misconception'
          if (confusable) {
            metadata.confusableConceptId = confusable
            if (!blamedConceptId && conceptIds.includes(confusable)) blamedConceptId = confusable
          }
        }
      }
    }

    inputs.push({
      userId: target.userId,
      projectId: target.projectId,
      topicId: target.topicOf(index),
      itemKey: target.itemKeyOf(index),
      conceptIds,
      blamedConceptId,
      source: target.source,
      score,
      assistance: level,
      confidence: given.confidence,
      gradedBy: isShort ? 'model' : 'rule',
      sessionKey: target.sessionKey,
      metadata,
      at: input.at,
    })
  }
  return inputs
}

export type QuizEvidenceInput = Omit<Parameters<typeof buildQuizEvidence>[0], 'knownConceptIds'> & { timeZone: string }

/** How many owed evidence writes one visit tries again. */
const RETRY_LIMIT = 5

/**
 * Writes a graded quiz as evidence. Replaces any evidence already stored for the attempt, so
 * applying the same attempt twice leaves one set of events. Called after the attempt has been
 * stored: a failure here is logged and never takes the student's result away. Returns whether the
 * evidence is written (true also when the quiz names no concepts), so the caller can record that
 * it is, or leave the attempt marked as owing it.
 */
export async function recordQuizEvidence(input: QuizEvidenceInput): Promise<boolean> {
  try {
    const wanted = [
      ...new Set(
        input.questions.flatMap((q) => (Array.isArray(q.concept_ids) ? q.concept_ids : [])).filter((id): id is string => typeof id === 'string')
      ),
    ]
    if (wanted.length === 0) return true
    const known = await prisma.concept.findMany({
      where: { id: { in: wanted }, projectId: input.projectId, status: 'active' },
      select: { id: true },
    })
    const inputs = buildQuizEvidence({ ...input, knownConceptIds: new Set(known.map((c) => c.id)) })
    if (inputs.length === 0) return true
    // A quiz whose rule items were written early (spec 18.9) adds only what is missing; the others replace the attempt's session.
    await recordEvidence(
      inputs,
      input.skipIfPresent
        ? { timeZone: input.timeZone, userId: input.userId, skipIfPresent: true }
        : { timeZone: input.timeZone, userId: input.userId, replaceSessionKeys: [`quiz:${input.attemptId}`] }
    )
    return true
  } catch (error) {
    console.error('Recording quiz evidence failed:', error)
    return false
  }
}

/** What an attempt keeps until its evidence is written: everything but the attempt id and the zone; none when nothing is owed. */
export function pendingQuizEvidence(
  input: Omit<QuizEvidenceInput, 'attemptId' | 'timeZone'>
): Prisma.InputJsonObject | undefined {
  // A quiz that names no concepts owes nothing.
  if (!input.questions.some((q) => Array.isArray(q.concept_ids) && q.concept_ids.length > 0)) return undefined
  return JSON.parse(JSON.stringify({ ...input, at: input.at?.toISOString() })) as Prisma.InputJsonObject
}

function readPendingQuizEvidence(value: unknown): Omit<QuizEvidenceInput, 'attemptId' | 'timeZone'> | null {
  if (!isRecord(value)) return null
  const { userId, projectId, topicId, quizSetId, questions, answers, graded, at } = value
  if (typeof userId !== 'string' || typeof projectId !== 'string' || typeof topicId !== 'string') return null
  if (!Array.isArray(questions) || !isRecord(answers) || !Array.isArray(graded)) return null
  return {
    userId,
    projectId,
    topicId,
    quizSetId: typeof quizSetId === 'string' ? quizSetId : null,
    questions: questions.filter(isRecord),
    answers: answers as Record<string, QuizAnswer>,
    graded: graded.filter(isRecord) as unknown as GradedQuestion[],
    at: typeof at === 'string' ? new Date(at) : undefined,
    sameDayRepeat: value.sameDayRepeat === true,
    skipIfPresent: value.skipIfPresent === true,
  }
}

/** Marks the attempt's evidence as written and drops the copy kept for a retry. */
async function markQuizEvidenceRecorded(attemptId: string): Promise<void> {
  try {
    await prisma.quizAttempt.updateMany({
      where: { id: attemptId },
      data: { evidenceRecordedAt: new Date(), evidencePending: Prisma.DbNull },
    })
  } catch (error) {
    console.error('Marking quiz evidence as written failed:', error)
  }
}

/** Counts a failed write against the attempt's budget (see evidence-retry-budget.ts). */
async function markQuizEvidenceFailed(attemptId: string): Promise<void> {
  try {
    const updated = await prisma.quizAttempt.update({
      where: { id: attemptId },
      data: { evidenceAttempts: { increment: 1 }, evidenceTriedAt: new Date() },
      select: { evidenceAttempts: true },
    })
    logIfGivenUp('quiz', attemptId, updated.evidenceAttempts)
  } catch (error) {
    console.error('Counting a failed quiz evidence write failed:', error)
  }
}

/** Writes the evidence of a stored attempt, then marks the attempt; on a failure the mark stays unset. */
export async function recordAttemptEvidence(input: QuizEvidenceInput): Promise<void> {
  if (await recordQuizEvidence(input)) await markQuizEvidenceRecorded(input.attemptId)
  else await markQuizEvidenceFailed(input.attemptId)
}

/**
 * Tries again the evidence of this student's attempts that owe it (the write failed after the result
 * committed), a few at a time, oldest first, each at most once an hour and up to a few tries (a copy that
 * keeps failing is given up on and logged, and never starves the others). Safe to repeat: the write replaces the attempt's session.
 * With nothing owed it is one small query. Returns how many it wrote.
 */
export async function retryPendingQuizEvidence(userId: string, limit = RETRY_LIMIT): Promise<number> {
  try {
    const owed = await prisma.quizAttempt.findMany({
      where: { userId, evidenceRecordedAt: null, evidencePending: { not: Prisma.DbNull }, ...dueForEvidenceRetry() },
      orderBy: { takenAt: 'asc' },
      take: limit,
      select: { id: true, evidencePending: true },
    })
    if (owed.length === 0) return 0
    const timeZone = await studentTimeZone()
    let written = 0
    for (const attempt of owed) {
      const pending = readPendingQuizEvidence(attempt.evidencePending)
      // A copy that cannot be read can never be written: stop asking for it.
      if (!pending) {
        console.error(`Quiz attempt ${attempt.id} has an unreadable pending evidence copy; dropping it, nothing is written.`)
        await markQuizEvidenceRecorded(attempt.id)
        continue
      }
      if (await recordQuizEvidence({ ...pending, attemptId: attempt.id, timeZone })) {
        await markQuizEvidenceRecorded(attempt.id)
        written += 1
      } else {
        await markQuizEvidenceFailed(attempt.id)
      }
    }
    return written
  } catch (error) {
    console.error('Retrying quiz evidence failed:', error)
    return 0
  }
}

/**
 * Whether this set was already taken earlier the same local day (spec 7.3): by a graded attempt, or by a submission
 * that is waiting for the AI. The student has just seen those answers, so a second submission of the same questions is
 * level 2. `at` is when the new one was taken; `exceptId` is its own attempt or submission id, when it has one.
 */
export async function takenEarlierToday(input: {
  userId: string
  topicId: string
  quizSetId: string | null
  at: Date
  timeZone: string
  exceptId?: string
}): Promise<boolean> {
  const { userId, topicId, quizSetId, at, timeZone, exceptId } = input
  const notSelf = exceptId ? { id: { not: exceptId } } : {}
  const [attempt, submission] = await Promise.all([
    prisma.quizAttempt.findFirst({ where: { userId, topicId, quizSetId, takenAt: { lt: at }, ...notSelf }, orderBy: { takenAt: 'desc' }, select: { takenAt: true } }),
    prisma.quizSubmission.findFirst({ where: { userId, topicId, quizSetId, submittedAt: { lt: at }, ...notSelf }, orderBy: { submittedAt: 'desc' }, select: { submittedAt: true } }),
  ])
  const day = (instant: Date) => {
    const { year, month, day: d } = localDateParts(instant, timeZone)
    return `${year}-${month}-${d}`
  }
  const today = day(at)
  return [attempt?.takenAt, submission?.submittedAt].some((earlier) => !!earlier && day(earlier) === today)
}
