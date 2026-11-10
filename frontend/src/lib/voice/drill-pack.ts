import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { prisma } from '@/lib/db/prisma'
import {
  extractQuestionsFromContent,
  extractTextFromNotes,
  filterConceptQuestions,
  normalizeVoiceQuestion,
  VoiceQuestion,
} from '@/lib/voice/concept'
import { aiServiceHeaders } from '@/lib/ai-service/headers'
import type { VoiceQuizStatus } from '@/features/voice/quiz-status'

import { SPRINT_MAX_QUESTIONS, SPRINT_QUESTIONS_PER_TOPIC, SPRINT_TOPICS } from './sprint-size'

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const MAX_NOTES_CHARS = 24000

const dedupeQuestions = (questions: VoiceQuestion[]) => {
  const seen = new Set<string>()
  return questions.filter((question) => {
    const key = question.question_text.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Who the drill generation is billed to (the AI service writes both on the ledger). */
type Billing = { userId: string; projectId: string }

const buildConceptQuestionsFromNotes = async (
  billing: Billing,
  topicName: string,
  topicId: string,
  notesText: string,
  count: number
): Promise<VoiceQuestion[]> => {
  const response = await fetch(`${AI_SERVICE_URL}/voice/generate-drill`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: aiServiceHeaders(),
    body: JSON.stringify({
      user_id: billing.userId,
      project_id: billing.projectId,
      topic: topicName,
      topic_id: topicId,
      notes: notesText.slice(0, MAX_NOTES_CHARS),
      count,
      difficulty: 'medium',
    }),
  })

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  const questions = Array.isArray(data.questions) ? data.questions : []
  return dedupeQuestions(filterConceptQuestions(
    questions
      .map((q: unknown) => normalizeVoiceQuestion((q || {}) as Partial<VoiceQuestion>))
      .filter((q: VoiceQuestion | null): q is VoiceQuestion => q !== null)
      .map((q: VoiceQuestion) => ({ ...q, source: q.source || 'generated' }))
  ))
}

type TopicWithContent = { id: string; name: string; content: { contentType: string; contentData: unknown }[] }

/**
 * The topic's quiz questions as the voice coach can use them: the quiz stored with the topic, else the newest quiz set (a topic
 * whose quiz was written as a set has no copy in its content). `total` counts them all, `usable` those the coach can ask aloud.
 */
async function topicQuizQuestions(topic: TopicWithContent): Promise<{ total: number; usable: VoiceQuestion[] }> {
  const quizContent = topic.content.find((c) => c.contentType === 'topic_quiz')
  let raw = extractQuestionsFromContent(quizContent?.contentData)
  if (raw.length === 0) {
    const newest = await prisma.topicQuiz.findFirst({ where: { topicId: topic.id, kind: 'standard' }, orderBy: { createdAt: 'desc' }, select: { questions: true } })
    raw = extractQuestionsFromContent(newest?.questions)
  }
  const usable = dedupeQuestions(filterConceptQuestions(
    raw
      .map((q) => normalizeVoiceQuestion(q))
      .filter((q): q is VoiceQuestion => q !== null)
      .map((q) => ({ ...q, source: 'topic_quiz', topic_id: topic.id }))
  ))
  return { total: raw.length, usable }
}

/**
 * Whether Quiz me can begin on these topics, worked out without a model call, so the lobby can say so before Start. It can when
 * a topic has a quiz question the coach can ask aloud, or has notes the coach can write questions from. Otherwise it says which
 * is missing: no quiz at all, or a quiz whose questions are all working that cannot be asked out loud.
 */
export async function voiceQuizStatus(topicIds: string[], userId: string): Promise<VoiceQuizStatus> {
  if (topicIds.length === 0) return { state: 'missing', reason: 'no_quiz', total: 0 }
  const topics = await prisma.topic.findMany({
    where: { id: { in: topicIds }, project: { userId } },
    include: { content: { select: { contentType: true, contentData: true } } },
  })
  let total = 0
  for (const topic of topics) {
    const quiz = await topicQuizQuestions(topic)
    if (quiz.usable.length > 0) return { state: 'ready' }
    if (extractTextFromNotes(topic.content.find((c) => c.contentType === 'section_notes')?.contentData)) return { state: 'ready' }
    total += quiz.total
  }
  return { state: 'missing', reason: total > 0 ? 'not_speakable' : 'no_quiz', total }
}

export const buildTopicQuestionSet = async (
  topicId: string,
  userId: string
): Promise<VoiceQuestion[]> => {
  const topic = await prisma.topic.findFirst({
    where: {
      id: topicId,
      project: { userId },
    },
    include: {
      content: true,
    },
  })

  if (!topic) {
    return []
  }

  const questions = (await topicQuizQuestions(topic)).usable

  if (questions.length > 0) {
    return questions
  }

  const notesContent = topic.content.find(c => c.contentType === 'section_notes')
  const notesText = extractTextFromNotes(notesContent?.contentData)
  if (!notesText) {
    return []
  }

  const generated = await buildConceptQuestionsFromNotes({ userId, projectId: topic.projectId }, topic.name, topic.id, notesText, 10)
  return dedupeQuestions(generated.map(q => ({ ...q, topic_id: topic.id })))
}

export const buildSprintQuestionSet = async (
  projectId: string,
  userId: string
): Promise<VoiceQuestion[]> => {
  await applyPendingQuizResults(userId)
  const topics = await prisma.topic.findMany({
    where: {
      projectId,
      project: { userId },
      userConfirmed: true,
    },
    // In course order, so topics that tie below (none opened yet) are taken the same way every time.
    orderBy: { orderIndex: 'asc' },
    include: {
      content: true,
      progress: {
        where: { userId },
        select: {
          quizScore: true,
          quizCompleted: true,
          notesCompleted: true,
          examplesCompleted: true,
        },
      },
    },
  })

  if (topics.length === 0) return []

  const ranked = topics
    .map(topic => {
      const progress = topic.progress[0]
      const score = progress?.quizScore ?? 0
      const incomplete =
        !progress?.quizCompleted || !progress?.notesCompleted || !progress?.examplesCompleted
      return {
        topic,
        score,
        priority: incomplete ? score - 10 : score,
      }
    })
    .sort((a, b) => a.priority - b.priority)

  const selected = ranked.slice(0, SPRINT_TOPICS)
  const combined: VoiceQuestion[] = []

  for (const entry of selected) {
    const topic = entry.topic
    let questions = (await topicQuizQuestions(topic)).usable

    if (questions.length === 0) {
      const notesContent = topic.content.find(c => c.contentType === 'section_notes')
      const notesText = extractTextFromNotes(notesContent?.contentData)
      if (notesText) {
        questions = (await buildConceptQuestionsFromNotes({ userId, projectId }, topic.name, topic.id, notesText, 6))
          .map(q => ({ ...q, topic_id: topic.id }))
      }
    }

    combined.push(...questions.slice(0, SPRINT_QUESTIONS_PER_TOPIC).map(q => ({
      ...q,
      source: q.source || topic.name,
      topic_id: q.topic_id || topic.id,
    })))
  }

  return dedupeQuestions(combined).slice(0, SPRINT_MAX_QUESTIONS)
}
