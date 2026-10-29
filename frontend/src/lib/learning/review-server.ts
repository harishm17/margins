import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import { loadAllQuizQuestionSets } from './quiz-sets'
import { displayMastery } from './mastery-math'
import {
  FRESH_REVIEW_PREREQUISITE_QUESTIONS,
  FRESH_REVIEW_QUESTIONS,
  focusFromConcepts,
  missedConcepts,
  missedQuestions,
  pickPrerequisite,
  questionSetKey,
  reviewDifficulty,
  type MissedQuestion,
  type ReviewDifficulty,
} from './missed'

type RawQuestion = Record<string, unknown>

/** The questions the student got wrong in their last two attempts on a topic (no model call). */
export async function getMissedQuestions(userId: string, topicId: string): Promise<MissedQuestion[]> {
  await applyPendingQuizResults(userId)
  const attempts = await prisma.quizAttempt.findMany({
    where: { userId, topicId },
    orderBy: { takenAt: 'desc' },
    take: 2,
    select: { quizSetId: true, results: true },
  })
  if (attempts.length === 0) return []
  const sets = await loadAllQuizQuestionSets(topicId)
  return missedQuestions(
    attempts.flatMap((attempt) => {
      const questions = sets.get(attempt.quizSetId ?? null)
      return questions ? [{ questions, results: attempt.results }] : []
    })
  )
}

/** How many questions each topic has to retry, for the review list. One query for the attempts of all the topics. */
export async function countMissedByTopic(userId: string, topicIds: string[]): Promise<Map<string, number>> {
  await applyPendingQuizResults(userId)
  const counts = new Map<string, number>()
  if (topicIds.length === 0) return counts
  const attempts = await prisma.quizAttempt.findMany({
    where: { userId, topicId: { in: topicIds } },
    orderBy: { takenAt: 'desc' },
    select: { topicId: true, quizSetId: true, results: true },
  })
  const byTopic = new Map<string, typeof attempts>()
  for (const attempt of attempts) {
    const list = byTopic.get(attempt.topicId) ?? []
    if (list.length < 2) list.push(attempt)
    byTopic.set(attempt.topicId, list)
  }
  for (const [topicId, list] of byTopic) {
    const sets = await loadAllQuizQuestionSets(topicId)
    const missed = missedQuestions(
      list.flatMap((attempt) => {
        const questions = sets.get(attempt.quizSetId ?? null)
        return questions ? [{ questions, results: attempt.results }] : []
      })
    )
    counts.set(topicId, missed.length)
  }
  return counts
}

/**
 * A quiz set of the questions the student missed, copied from the sets they came from. If a set
 * with the same questions already exists it is reused, so retrying twice does not pile up sets.
 * Returns null when there is nothing to retry.
 */
export async function createRetrySet(
  userId: string,
  topicId: string
): Promise<{ quizSetId: string; questionCount: number } | null> {
  const missed = await getMissedQuestions(userId, topicId)
  if (missed.length === 0) return null
  const questions = missed.map((item) => item.question)
  const wanted = questionSetKey(questions)

  const existing = await prisma.topicQuiz.findMany({
    where: { topicId, kind: 'retry' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, questions: true },
  })
  for (const set of existing) {
    const stored = Array.isArray(set.questions) ? (set.questions as RawQuestion[]) : []
    if (questionSetKey(stored) === wanted) return { quizSetId: set.id, questionCount: stored.length }
  }

  // The first quiz was stored before quiz sets existed (topic_content). Keep it visible as Set 1
  // before the first set row is written, as the AI service does when it writes a new set.
  if ((await prisma.topicQuiz.count({ where: { topicId } })) === 0) {
    const legacy = await prisma.topicContent.findUnique({
      where: { topicId_contentType: { topicId, contentType: 'topic_quiz' } },
      select: { contentData: true, createdAt: true, updatedAt: true },
    })
    if (Array.isArray(legacy?.contentData) && legacy.contentData.length > 0) {
      await prisma.topicQuiz.create({
        data: { topicId, questions: legacy.contentData as object[], createdAt: legacy.updatedAt ?? legacy.createdAt },
      })
    }
  }

  const created = await prisma.topicQuiz.create({
    data: { topicId, kind: 'retry', questions: questions as object[] },
    select: { id: true },
  })
  return { quizSetId: created.id, questionCount: questions.length }
}

export type FreshReviewPlan = {
  difficulty: ReviewDifficulty
  focus: string | null
  prerequisiteTopicId: string | null
}

/**
 * What a fresh review set is made of: difficulty from the topic's mastery, a focus on the concepts
 * of the questions missed lately, and the weakest prerequisite topic to draw 1-2 questions from.
 */
export async function planFreshReview(userId: string, topic: { id: string; projectId: string }): Promise<FreshReviewPlan> {
  await applyPendingQuizResults(userId)
  const [schedule, missed, row] = await Promise.all([
    prisma.reviewSchedule.findUnique({
      where: { userId_topicId: { userId, topicId: topic.id } },
      select: { mastery: true, dueAt: true, intervalDays: true },
    }),
    getMissedQuestions(userId, topic.id),
    prisma.topic.findUnique({ where: { id: topic.id }, select: { prerequisiteIds: true } }),
  ])

  const prerequisiteIds = (row?.prerequisiteIds ?? []).filter((id) => id !== topic.id)
  const prerequisites =
    prerequisiteIds.length === 0
      ? []
      : await prisma.topic.findMany({
          where: { id: { in: prerequisiteIds }, projectId: topic.projectId },
          select: { id: true, reviewSchedules: { where: { userId }, take: 1, select: { mastery: true, dueAt: true, intervalDays: true } } },
        })
  const now = Date.now()
  const pick = pickPrerequisite(
    prerequisites.map((item) => ({
      id: item.id,
      mastery: displayMastery(item.reviewSchedules[0]?.mastery, item.reviewSchedules[0], now),
    }))
  )

  return {
    difficulty: reviewDifficulty(displayMastery(schedule?.mastery, schedule, now)),
    focus: focusFromConcepts(missedConcepts(missed)),
    prerequisiteTopicId: pick?.id ?? null,
  }
}

/** The preferences of the regeneration job for a fresh review set. */
export function freshReviewPreferences(plan: FreshReviewPlan) {
  return {
    question_count: FRESH_REVIEW_QUESTIONS,
    difficulty_level: plan.difficulty,
    ...(plan.focus ? { focus: plan.focus } : {}),
    ...(plan.prerequisiteTopicId
      ? { prerequisite_topic_id: plan.prerequisiteTopicId, prerequisite_questions: FRESH_REVIEW_PREREQUISITE_QUESTIONS }
      : {}),
  }
}
