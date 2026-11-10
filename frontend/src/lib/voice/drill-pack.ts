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
import { callSignal } from '@/lib/ai-service/client-signal'
import { promptsV2 } from '@/lib/prompt-revision'
import type { VoiceQuizStatus } from '@/features/voice/quiz-status'

import { SPRINT_MAX_QUESTIONS, SPRINT_QUESTIONS_PER_TOPIC, SPRINT_TOPICS } from './sprint-size'

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const MAX_NOTES_CHARS = 24000

/** The AI service refused the drill because its voice flag differs from the web app's (R9). */
export const PROMPTS_MISMATCH = 'PROMPTS_MISMATCH'
export class PromptsMismatchError extends Error {
  readonly code = PROMPTS_MISMATCH
  constructor() {
    super(PROMPTS_MISMATCH)
    this.name = 'PromptsMismatchError'
  }
}

/**
 * The questions could not be written just now: the AI service failed, timed out or refused (the day's allowance, an
 * outage). Not the same as a topic with nothing to ask about: that one sends the student to create notes and a quiz,
 * which they already have. `code` is the service's error code, for the words the student is shown.
 */
export class DrillGenerationError extends Error {
  constructor(readonly code: string) {
    super(`Drill generation failed: ${code}`)
    this.name = 'DrillGenerationError'
  }
}

async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error_code?: unknown }
    return typeof body.error_code === 'string' ? body.error_code : null
  } catch {
    return null
  }
}

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
  let response: Response
  try {
    response = await fetch(`${AI_SERVICE_URL}/voice/generate-drill`, {
      method: 'POST',
      signal: callSignal(20000),
      headers: aiServiceHeaders(),
      body: JSON.stringify({
        user_id: billing.userId,
        project_id: billing.projectId,
        topic: topicName,
        topic_id: topicId,
        notes: notesText.slice(0, MAX_NOTES_CHARS),
        count,
        difficulty: 'medium',
        // R9: refused with 409 PROMPTS_MISMATCH when the AI service's voice flag differs from this one.
        prompts_v2_voice: promptsV2('voice'),
      }),
    })
  } catch {
    // Not reachable, or no answer in time.
    throw new DrillGenerationError('VOICE_UNAVAILABLE')
  }

  if (!response.ok) {
    const code = await errorCodeOf(response)
    // A half-set voice flag is refused, and the student is told to try again shortly.
    if (response.status === 409 && code === PROMPTS_MISMATCH) throw new PromptsMismatchError()
    // Any other failure is a failure, said as one: an empty list here read as "this topic has no quiz".
    throw new DrillGenerationError(code ?? 'VOICE_UNAVAILABLE')
  }

  const data = await response.json().catch(() => {
    throw new DrillGenerationError('LLM_BAD_OUTPUT')
  })
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
  let failed: DrillGenerationError | null = null

  for (const entry of selected) {
    const topic = entry.topic
    let questions = (await topicQuizQuestions(topic)).usable

    if (questions.length === 0) {
      const notesContent = topic.content.find(c => c.contentType === 'section_notes')
      const notesText = extractTextFromNotes(notesContent?.contentData)
      if (notesText) {
        try {
          questions = (await buildConceptQuestionsFromNotes({ userId, projectId }, topic.name, topic.id, notesText, 6))
            .map(q => ({ ...q, topic_id: topic.id }))
        } catch (error) {
          // One topic's questions could not be written: the sprint goes on with the others.
          if (!(error instanceof DrillGenerationError)) throw error
          failed ??= error
          // The service is down or the allowance is spent: the next topic would fail the same way.
          continue
        }
      }
    }

    combined.push(...questions.slice(0, SPRINT_QUESTIONS_PER_TOPIC).map(q => ({
      ...q,
      source: q.source || topic.name,
      topic_id: q.topic_id || topic.id,
    })))
  }

  const pack = dedupeQuestions(combined).slice(0, SPRINT_MAX_QUESTIONS)
  // Nothing to ask, and writing questions failed on the way: that failure is the reason, not a course without a quiz.
  if (pack.length === 0 && failed) throw failed
  return pack
}
