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

const buildConceptQuestionsFromNotes = async (
  topicName: string,
  notesText: string,
  count: number
): Promise<VoiceQuestion[]> => {
  const response = await fetch(`${AI_SERVICE_URL}/voice/generate-drill`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: aiServiceHeaders(),
    body: JSON.stringify({
      topic: topicName,
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

  const quizContent = topic.content.find(c => c.contentType === 'topic_quiz')
  const rawQuiz = extractQuestionsFromContent(quizContent?.contentData)
  let questions = dedupeQuestions(filterConceptQuestions(
    rawQuiz
      .map((q) => normalizeVoiceQuestion(q))
      .filter((q): q is VoiceQuestion => q !== null)
      .map(q => ({ ...q, source: 'topic_quiz', topic_id: topic.id }))
  ))

  if (questions.length > 0) {
    return questions
  }

  const notesContent = topic.content.find(c => c.contentType === 'section_notes')
  const notesText = extractTextFromNotes(notesContent?.contentData)
  if (!notesText) {
    return []
  }

  const generated = await buildConceptQuestionsFromNotes(topic.name, notesText, 10)
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
    },
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

  const selected = ranked.slice(0, 3)
  const combined: VoiceQuestion[] = []

  for (const entry of selected) {
    const topic = entry.topic
    const quizContent = topic.content.find(c => c.contentType === 'topic_quiz')
    const rawQuiz = extractQuestionsFromContent(quizContent?.contentData)
    let questions = dedupeQuestions(filterConceptQuestions(
      rawQuiz
        .map((q) => normalizeVoiceQuestion(q))
        .filter((q): q is VoiceQuestion => q !== null)
        .map(q => ({ ...q, source: 'topic_quiz', topic_id: topic.id }))
    ))

    if (questions.length === 0) {
      const notesContent = topic.content.find(c => c.contentType === 'section_notes')
      const notesText = extractTextFromNotes(notesContent?.contentData)
      if (notesText) {
        questions = (await buildConceptQuestionsFromNotes(topic.name, notesText, 6))
          .map(q => ({ ...q, topic_id: topic.id }))
      }
    }

    combined.push(...questions.slice(0, 4).map(q => ({
      ...q,
      source: q.source || topic.name,
      topic_id: q.topic_id || topic.id,
    })))
  }

  return dedupeQuestions(combined).slice(0, 12)
}
