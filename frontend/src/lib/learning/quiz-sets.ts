import { prisma } from '@/lib/db/prisma'
import type { OwnedTopic } from '@/server/owned'
import { asQuestionList } from './quiz-questions'

type RawQuestion = Record<string, unknown>

/** The first quiz, stored before quiz sets existed, lives in topic_content. */
async function loadLegacyQuestions(topic: OwnedTopic): Promise<RawQuestion[] | null> {
  const content = await prisma.topicContent.findUnique({
    where: { topicId_contentType: { topicId: topic.id, contentType: 'topic_quiz' } },
    select: { contentData: true },
  })
  return asQuestionList(content?.contentData)
}

/**
 * The stored questions (with answer keys) for grading and review. Never send these to the
 * browser before the student has submitted. Without a set id this is the legacy quiz.
 */
export async function loadQuizQuestions(
  topic: OwnedTopic,
  quizSetId: string | null | undefined
): Promise<RawQuestion[] | null> {
  if (!quizSetId) return loadLegacyQuestions(topic)
  const set = await prisma.topicQuiz.findFirst({
    where: { id: quizSetId, topicId: topic.id },
    select: { questions: true },
  })
  return asQuestionList(set?.questions)
}

/**
 * Every quiz set of a topic, keyed by set id. Attempts taken on the first quiz (stored before sets
 * existed) have no set id, so that quiz is under the key `null`: it is the topic_content copy, until
 * the topic gets a set row. Writing the first set row copies the first quiz into it (oldest), and the
 * content row is then overwritten by the new set, so from then on `null` is the oldest set.
 */
export async function loadAllQuizQuestionSets(
  topic: OwnedTopic
): Promise<Map<string | null, RawQuestion[]>> {
  const [sets, legacy] = await Promise.all([
    prisma.topicQuiz.findMany({ where: { topicId: topic.id, kind: { in: ['standard', 'retry'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, questions: true } }),
    loadLegacyQuestions(topic),
  ])
  const map = new Map<string | null, RawQuestion[]>()
  let oldest: RawQuestion[] | null = null
  for (const set of sets) {
    const questions = asQuestionList(set.questions)
    if (!questions) continue
    map.set(set.id, questions)
    oldest ??= questions
  }
  const first = oldest ?? legacy
  if (first) map.set(null, first)
  return map
}
