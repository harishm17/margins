/**
 * "Practise what you missed" after a mock exam: which concepts (or, for an exam whose questions name none, which topics)
 * the missed questions were about. The review session then serves new questions on them; the exam's own questions are not
 * served again, because answering the same question again straight away mostly tests short-term memory.
 */

import { prisma } from '@/lib/db/prisma'
import { MAX_REVIEW_ITEMS } from './review-session'

type RawQuestion = Record<string, unknown>

const isRecord = (value: unknown): value is RawQuestion => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [])

export type MissedScope = { missed: number; conceptIds: string[]; topicIds: string[] }

/**
 * What the missed questions of a graded submission name. A missed question is a graded one that was wrong; one the grader could
 * not grade ("needs review") is not counted as missed, as on the results page. Order follows the exam; ids appear once.
 */
export function missedScope(questions: unknown, aiGrading: unknown): MissedScope {
  const list = Array.isArray(questions) ? questions.filter(isRecord) : []
  const graded = isRecord(aiGrading) && Array.isArray(aiGrading.graded_questions) ? aiGrading.graded_questions.filter(isRecord) : []
  const byIndex = new Map<number, RawQuestion>()
  for (const item of graded) if (typeof item.question_index === 'number') byIndex.set(item.question_index, item)
  const concepts = new Set<string>()
  const topics = new Set<string>()
  let missed = 0
  list.forEach((question, index) => {
    const result = byIndex.get(index)
    if (!result || result.is_correct === true || result.needs_review === true) return
    missed += 1
    for (const id of strings(question.concept_ids)) concepts.add(id)
    // A short answer the grader blamed on one concept counts that concept too.
    if (typeof result.blamed_concept_id === 'string' && result.blamed_concept_id) concepts.add(result.blamed_concept_id)
    if (typeof question.topic_id === 'string' && question.topic_id) topics.add(question.topic_id)
  })
  return { missed, conceptIds: [...concepts], topicIds: [...topics] }
}

export type ExamPractice =
  /** Questions on the concepts the missed ones were about. */
  | { kind: 'concepts'; conceptIds: string[]; count: number }
  /** The missed questions named no concept: questions on the concepts of their topics. */
  | { kind: 'topics'; topicIds: string[]; count: number }

/**
 * The practice the results page can offer, or null when there is none (nothing missed, or no concept of this course left to
 * ask about). `count` is how many questions the session is set up to serve: one for each concept, at most a review's size and,
 * when the concepts come from topics, at most the number missed.
 */
export async function examPractice(projectId: string, questions: unknown, aiGrading: unknown): Promise<ExamPractice | null> {
  const scope = missedScope(questions, aiGrading)
  if (scope.missed === 0) return null
  if (scope.conceptIds.length > 0) {
    const active = await prisma.concept.findMany({
      where: { id: { in: scope.conceptIds }, projectId, status: 'active' },
      select: { id: true },
    })
    if (active.length > 0) return { kind: 'concepts', conceptIds: active.map((c) => c.id), count: Math.min(MAX_REVIEW_ITEMS, active.length) }
  }
  if (scope.topicIds.length > 0) {
    const topics = await prisma.topic.findMany({ where: { id: { in: scope.topicIds }, projectId }, select: { id: true } })
    if (topics.length > 0) {
      const available = await prisma.concept.count({ where: { topicId: { in: topics.map((t) => t.id) }, projectId, status: 'active' } })
      const count = Math.min(MAX_REVIEW_ITEMS, scope.missed, available)
      if (count > 0) return { kind: 'topics', topicIds: topics.map((t) => t.id), count }
    }
  }
  return null
}
