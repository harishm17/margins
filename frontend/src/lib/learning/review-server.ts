import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import { loadAllQuizQuestionSets } from './quiz-sets'
import { topicStanding, topicStandings } from './topic-standing'
import {
  FRESH_REVIEW_PREREQUISITE_QUESTIONS,
  FRESH_REVIEW_QUESTIONS,
  focusFromConcepts,
  missedConceptIds,
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

/** When the newest attempt on a topic was taken; "Retry what you missed" opens the next local day. */
export async function getLastAttemptAt(userId: string, topicId: string): Promise<Date | null> {
  const last = await prisma.quizAttempt.findFirst({ where: { userId, topicId }, orderBy: { takenAt: 'desc' }, select: { takenAt: true } })
  return last?.takenAt ?? null
}

/**
 * How many questions each topic has to retry, and when its newest attempt was taken, for the review
 * list. One query for the attempts of all the topics.
 */
export async function countMissedByTopic(
  userId: string,
  topicIds: string[]
): Promise<Map<string, { count: number; lastAttemptAt: Date | null }>> {
  await applyPendingQuizResults(userId)
  const counts = new Map<string, { count: number; lastAttemptAt: Date | null }>()
  if (topicIds.length === 0) return counts
  const attempts = await prisma.quizAttempt.findMany({
    where: { userId, topicId: { in: topicIds } },
    orderBy: { takenAt: 'desc' },
    select: { topicId: true, quizSetId: true, results: true, takenAt: true },
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
    counts.set(topicId, { count: missed.length, lastAttemptAt: list[0]?.takenAt ?? null })
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
  if ((await prisma.topicQuiz.count({ where: { topicId, kind: { in: ['standard', 'retry'] } } })) === 0) {
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
  /** The concepts the missed questions test (their `concept_ids`), active ones only. */
  conceptIds: string[]
  prerequisiteTopicId: string | null
}

/**
 * What a fresh review set is made of: difficulty from the topic's mastery, a focus on the concepts
 * of the questions missed lately, and the weakest prerequisite topic to draw 1-2 questions from.
 */
export async function planFreshReview(userId: string, topic: { id: string; projectId: string }): Promise<FreshReviewPlan> {
  await applyPendingQuizResults(userId)
  const [standing, missed, row] = await Promise.all([
    topicStanding(userId, topic.id),
    getMissedQuestions(userId, topic.id),
    prisma.topic.findUnique({ where: { id: topic.id }, select: { prerequisiteIds: true } }),
  ])

  // The missed questions' concept ids are the focus; their names put it into words. Questions from before
  // the concept graph have no ids, so their `concepts_tested` text is the focus as it was.
  const missedIds = missedConceptIds(missed)
  const concepts =
    missedIds.length === 0
      ? []
      : await prisma.concept.findMany({
          where: { id: { in: missedIds }, projectId: topic.projectId, status: 'active' },
          select: { id: true, name: true },
        })
  const named = missedIds.flatMap((id) => concepts.filter((concept) => concept.id === id))

  const prerequisiteIds = (row?.prerequisiteIds ?? []).filter((id) => id !== topic.id)
  const prerequisites =
    prerequisiteIds.length === 0
      ? []
      : await prisma.topic.findMany({
          where: { id: { in: prerequisiteIds }, projectId: topic.projectId },
          select: { id: true },
        })
  const standings = await topicStandings(userId, prerequisites.map((item) => item.id))
  const pick = pickPrerequisite(prerequisites.map((item) => ({ id: item.id, mastery: standings.get(item.id)?.mastery ?? null })))

  return {
    difficulty: reviewDifficulty(standing.mastery),
    focus: focusFromConcepts(named.length > 0 ? named.map((concept) => concept.name) : missedConcepts(missed)),
    conceptIds: named.map((concept) => concept.id),
    prerequisiteTopicId: pick?.id ?? null,
  }
}

/** The preferences of the regeneration job for a fresh review set. */
export function freshReviewPreferences(plan: FreshReviewPlan) {
  return {
    question_count: FRESH_REVIEW_QUESTIONS,
    difficulty_level: plan.difficulty,
    ...(plan.focus ? { focus: plan.focus } : {}),
    ...(plan.conceptIds.length > 0 ? { concept_ids: plan.conceptIds } : {}),
    ...(plan.prerequisiteTopicId
      ? { prerequisite_topic_id: plan.prerequisiteTopicId, prerequisite_questions: FRESH_REVIEW_PREREQUISITE_QUESTIONS }
      : {}),
  }
}
