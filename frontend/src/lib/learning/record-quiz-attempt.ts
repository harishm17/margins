import { logServerError } from '@/lib/ops/log'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { computeTopicMastery, recordLearningSignal, upsertReviewSchedule, type Db } from './mastery'
import { topicStanding } from './topic-standing'
import type { GradedQuestion } from '@/lib/ai-service/grading'
import type { QuizAnswer } from './quiz-answers'
import { knownCorrect } from './warmup-bracket'
import { helpAfterMiss, type HelpAfterMiss } from './instruction-server'
import type { QuizReviewItem } from './quiz-review'

/** A quiz is "right" for scheduling the next review at this score (percent). */
export const QUIZ_PASS_SCORE = 70

/** A first quiz at this score or better, with guessed right answers counted wrong, moves the path past read and recall (spec 18.6). */
export const STRONG_START_SCORE = 0.8

/**
 * The share of points a student earned that were not luck: a right answer marked Guessing counts as wrong, the same
 * rule the warm-up's test-out uses (`knownCorrect`). 0 when the quiz has no points.
 */
export function strongStartScore(graded: GradedQuestion[], answers: Record<string, QuizAnswer>): number {
  const total = graded.reduce((sum, question) => sum + question.points_possible, 0)
  if (!(total > 0)) return 0
  const earned = graded.reduce((sum, question) => {
    const given = answers[String(question.question_index)]
    const counted = question.points_earned > 0 && knownCorrect({ conceptIds: [], correct: true, confidence: given?.confidence, confidenceLevel: given?.confidenceLevel })
    return sum + (counted ? question.points_earned : 0)
  }, 0)
  return earned / total
}

/** Whether this attempt is a strong start: level 0 (not a same-day repeat) and over the bar. */
export const isStrongStart = (graded: GradedQuestion[], answers: Record<string, QuizAnswer>, sameDayRepeat: boolean): boolean =>
  !sameDayRepeat && strongStartScore(graded, answers) >= STRONG_START_SCORE

/** What a quiz's results show for the questions that were missed (spec 18.5): where to look, and the explainer. */
export type QuizHelp = {
  helpAfterMiss: HelpAfterMiss
  /** The concept ids each missed question tests, by question index, so a pointer can sit under its own question. */
  missedConcepts: Record<string, string[]>
}

/**
 * `helpAfterMiss` for the concepts of the questions that were missed. Pointers come from stored claims, so they work
 * with the AI down. Null when nothing was missed or no missed question names a concept.
 */
export async function quizHelp(
  userId: string,
  topicId: string,
  questions: Record<string, unknown>[],
  review: Pick<QuizReviewItem, 'questionIndex' | 'isCorrect'>[]
): Promise<QuizHelp | null> {
  const missedConcepts: Record<string, string[]> = {}
  for (const item of review) {
    if (item.isCorrect) continue
    const ids = questions[item.questionIndex]?.concept_ids
    const conceptIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id) : []
    if (conceptIds.length > 0) missedConcepts[String(item.questionIndex)] = conceptIds
  }
  const all = [...new Set(Object.values(missedConcepts).flat())]
  if (all.length === 0) return null
  try {
    return { helpAfterMiss: await helpAfterMiss(prisma, { userId, topicId, conceptIds: all, surface: 'quiz' }), missedConcepts }
  } catch (error) {
    // Help is an addition to the result; the result itself must not fail for it.
    logServerError('Help after a missed quiz question failed', error)
    return null
  }
}

export type QuizOutcome = { nextReviewAt: Date | null; mastery: number | null; previousMastery: number | null }

export type RecordedQuizAttempt = {
  attempt: { id: string; score: number; takenAt: Date }
  /** The topic's best quiz score after this attempt. */
  bestScore: number
  /**
   * The topic's mastery before the attempt. What the attempt changed is read with quizOutcome once its
   * evidence is written, because a converted topic's figures come from the concepts' memory.
   */
  previousMastery: number | null
}

/** What a quiz changed, as the results say it: the figures every other screen shows (topic-standing.ts). */
export async function quizOutcome(userId: string, topicId: string, previousMastery: number | null, db: Db = prisma): Promise<QuizOutcome> {
  const standing = await topicStanding(userId, topicId, new Date(), db)
  return { nextReviewAt: standing.dueAt, mastery: standing.mastery, previousMastery }
}

export type QuizAttemptInput = {
  userId: string
  topic: { id: string; projectId: string }
  quizSetId: string | null
  answers: Record<string, string>
  results: Prisma.InputJsonValue
  score: number
  /** A fixed id, for a quiz that waited for the AI (the submission's own id). */
  id?: string
  /** When the quiz was taken, if not now. */
  takenAt?: Date
  /**
   * What the concept evidence is built from, stored with the attempt so a write that fails after the
   * commit can be tried again (see retryPendingQuizEvidence).
   */
  evidencePending?: Prisma.InputJsonObject
  /** The attempt is a strong start (`isStrongStart`): the topic is tested out when the rules below allow it. */
  strongStart?: boolean
}

/**
 * Stores a graded quiz attempt and every effect of it, on `db` (a transaction): the topic's
 * progress and best score, the learning signal, mastery and the next review date. Callers run it
 * in one transaction (recordQuizAttempt, applyQuizSubmission), so the attempt never exists without
 * its effects, and a failure part way leaves nothing behind.
 *
 * Times: the attempt, the learning signal and the topic's last access are stamped with the time the
 * quiz was taken; the review schedule (last reviewed, next due) counts from now, when the student
 * gets the result, so a long wait for the AI does not make the topic due the moment it is graded.
 *
 * Only ever called with a complete grading: a partial score must never reach mastery.
 */
export async function applyQuizAttempt(db: Db, input: QuizAttemptInput): Promise<RecordedQuizAttempt> {
  const { userId, topic, quizSetId, answers, results, score } = input
  const topicId = topic.id
  const takenAt = input.takenAt ?? new Date()

  const previousMastery = (await topicStanding(userId, topicId, new Date(), db)).mastery
  const attempt = await db.quizAttempt.create({
    data: { id: input.id, userId, topicId, quizSetId, answers, results, score, takenAt, evidencePending: input.evidencePending },
    select: { id: true, score: true, takenAt: true },
  })

  const progressKey = { topicId_userId: { topicId, userId } }
  const existingProgress = await db.topicProgress.findUnique({ where: progressKey })
  const currentBest = existingProgress?.quizScore
  const bestScore = currentBest === null || currentBest === undefined ? score : Math.max(currentBest, score)
  // Tested out: a strong first quiz on a standard set, before the student has done the topic's recall (spec 18.6).
  // The first time stays: a later strong quiz does not move it.
  const testedOut =
    input.strongStart === true &&
    !existingProgress?.recallAt &&
    !existingProgress?.testedOutAt &&
    (await isStandardSet(db, quizSetId))
  const lastSeen = existingProgress?.lastAccessedAt
  // A quiz applied late never moves "last accessed" back.
  const lastAccessedAt = lastSeen && lastSeen > takenAt ? lastSeen : takenAt

  await db.topicProgress.upsert({
    where: progressKey,
    update: { quizCompleted: true, quizScore: bestScore, lastAccessedAt, ...(testedOut ? { testedOutAt: takenAt } : {}) },
    create: {
      topicId,
      userId,
      notesCompleted: false,
      examplesCompleted: false,
      quizCompleted: true,
      quizScore: score,
      lastAccessedAt,
      ...(testedOut ? { testedOutAt: takenAt } : {}),
    },
  })

  await recordLearningSignal({
    userId,
    projectId: topic.projectId,
    topicId,
    source: 'quiz',
    score: score / 100,
    metadata: { attemptId: attempt.id, quizSetId },
    at: takenAt,
    db,
  })

  const mastery = await computeTopicMastery(userId, topic.projectId, topicId, db)
  await upsertReviewSchedule({
    userId,
    projectId: topic.projectId,
    topicId,
    mastery: mastery.mastery,
    wasCorrect: score >= QUIZ_PASS_SCORE,
    db,
  })

  return { attempt, bestScore, previousMastery }
}

/** The first quiz (no set id) and the sets the chain writes are standard; a retry set holds only what was missed. */
async function isStandardSet(db: Db, quizSetId: string | null): Promise<boolean> {
  if (!quizSetId) return true
  const set = await db.topicQuiz.findUnique({ where: { id: quizSetId }, select: { kind: true } })
  return set?.kind === 'standard'
}

/** A quiz graded at once: the attempt and all its effects in one transaction. */
export function recordQuizAttempt(input: QuizAttemptInput): Promise<RecordedQuizAttempt> {
  return prisma.$transaction((tx) => applyQuizAttempt(tx, input), { timeout: 20_000 })
}
