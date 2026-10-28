import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { topicsConfirmed } from '@/lib/course-setup'
import { getCourseShell } from '@/server/queries/courses'
import { extractQuestionsFromContent, filterConceptQuestions } from '@/lib/voice/concept'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

const REQUIRED_CONTENT = ['section_notes', 'solved_examples', 'interactive_examples', 'topic_quiz']

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: auth.user.id,
      },
      include: {
        materials: {
          select: { validationStatus: true },
        },
        topics: {
          include: {
            content: { select: { contentType: true, contentData: true } },
            progress: {
              where: { userId: auth.user.id },
              select: { quizCompleted: true, quizScore: true },
              take: 1,
            },
          },
        },
      },
    })

    if (!project) {
      return apiNotFound('Project not found')
    }

    const materialHealth = {
      total: project.materials.length,
      valid: project.materials.filter((material) => material.validationStatus === 'valid').length,
      invalid: project.materials.filter((material) => material.validationStatus === 'invalid').length,
      pending: project.materials.filter((material) => material.validationStatus === 'pending').length,
    }

    const topicCount = project.topics.length
    const confirmedTopics = project.topics.filter((topic) => topic.userConfirmed).length
    // "Confirmed" means what it means on every screen: the student confirmed the list (lib/course-setup.ts),
    // not that some topics are confirmed (a topic added by hand is, before the list is).
    const shell = await getCourseShell(auth.user.id, projectId)
    const listConfirmed = shell ? topicsConfirmed(shell.setup) : false
    const contentReadyTopics = project.topics.filter((topic) =>
      REQUIRED_CONTENT.every((type) =>
        topic.content.some((item) => item.contentType === type)
      )
    ).length
    const quizScores = project.topics
      .map((topic) => topic.progress[0])
      .filter((progress): progress is { quizCompleted: boolean; quizScore: number | null } =>
        Boolean(progress?.quizCompleted && typeof progress.quizScore === 'number')
      )
      .map((progress) => progress.quizScore as number)

    const quizReadyTopics = quizScores.length
    const averageQuizScore = quizReadyTopics > 0
      ? quizScores.reduce((sum, score) => sum + score, 0) / quizReadyTopics
      : 0

    const conceptualQuestionCount = project.topics.reduce((count, topic) => {
      const quizContent = topic.content.find((content) => content.contentType === 'topic_quiz')
      const conceptualQuestions = filterConceptQuestions(
        extractQuestionsFromContent(quizContent?.contentData)
      )
      return count + conceptualQuestions.length
    }, 0)
    const notesTopicCount = project.topics.filter((topic) =>
      topic.content.some((content) => content.contentType === 'section_notes')
    ).length
    const voiceReady = conceptualQuestionCount > 0 || notesTopicCount > 0

    const blockers: string[] = []
    if (materialHealth.valid === 0) blockers.push('No validated materials')
    if (!listConfirmed) blockers.push('Topics not confirmed')
    if (contentReadyTopics === 0) blockers.push('No fully generated learning content')
    if (!voiceReady) blockers.push('Voice drill has no conceptual questions')

    const readiness =
      blockers.length === 0
        ? 'ready'
        : materialHealth.valid === 0
          ? 'needs_materials'
          : !listConfirmed
            ? 'needs_topic_confirmation'
            : 'in_progress'

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      readiness,
      blockers,
      metrics: {
        materials: materialHealth,
        topics: {
          total: topicCount,
          confirmed: confirmedTopics,
          listConfirmed,
          withAllCoreContent: contentReadyTopics,
          quizCompleted: quizReadyTopics,
          averageQuizScore,
        },
        voice: {
          ready: voiceReady,
          conceptualQuestionCount,
          topicsWithNotes: notesTopicCount,
        },
      },
    })
  } catch (error) {
    console.error('Project health error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load project health')
  }
}
