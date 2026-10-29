import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { getCourseShell } from '@/server/queries/courses'
import { healthReadiness } from '@/lib/project-health'
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
    await applyPendingQuizResults(auth.user.id)
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
    const listConfirmed = shell?.setup.topics.listConfirmed ?? false
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

    // Materials are missing only where every other screen says so: setup at step 1 (a course that has
    // content stays set up after its files are deleted).
    const materialsMissing = shell ? shell.setup.mode === 'setup' && shell.setup.step === 1 : materialHealth.valid === 0
    const { blockers, readiness } = healthReadiness({
      materialsMissing,
      listConfirmed,
      contentReady: contentReadyTopics > 0,
      voiceReady,
    })

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
