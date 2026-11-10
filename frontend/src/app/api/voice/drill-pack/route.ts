import { logServerError } from '@/lib/ops/log'
import { id } from '@/lib/api/fields'
import { NextRequest, NextResponse } from 'next/server'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { ownedProject, ownedTopic } from '@/server/owned'
import { buildSprintQuestionSet, buildTopicQuestionSet, DrillGenerationError, PromptsMismatchError } from '@/lib/voice/drill-pack'
import { ApiErrorCode, apiError } from '@/lib/api/errors'
import { voiceErrorMessage } from '@/lib/voice/errors'

const drillPackSchema = z.object({
  mode: z.enum(['topic_drill', 'sprint']).default('topic_drill'),
  projectId: id(),
  topicId: id().optional(),
})

// Kept for API clients; the UI reads this through server queries.
async function handleGET(request: NextRequest) {
  try {
    const session = await requireAuth()
    // A GET, but one that can ask the model to write questions (a topic with notes and no quiz): it is limited like a
    // route that changes data.
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { searchParams } = new URL(request.url)

    const payload = drillPackSchema.parse({
      mode: searchParams.get('mode') || undefined,
      projectId: searchParams.get('projectId'),
      topicId: searchParams.get('topicId') || undefined,
    })

    if (!(await ownedProject(session.user.id, payload.projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    let questions = []

    if (payload.mode === 'topic_drill') {
      if (!payload.topicId) {
        return NextResponse.json({ error: 'topicId is required' }, { status: 400 })
      }
      // The topic is the student's own and in this course, as when a session starts (the session route).
      if (!(await ownedTopic(session.user.id, payload.topicId, payload.projectId))) {
        return NextResponse.json({ error: 'Topic not found' }, { status: 404 })
      }
      questions = await buildTopicQuestionSet(payload.topicId, session.user.id)
    } else {
      questions = await buildSprintQuestionSet(payload.projectId, session.user.id)
    }

    const preview = questions.slice(0, 5).map(q => ({
      question_text: q.question_text,
      question_type: q.question_type,
      concepts_tested: q.concepts_tested || [],
      source: q.source || 'topic_quiz',
    }))

    return NextResponse.json({
      questionCount: questions.length,
      preview,
    })
  } catch (error) {
    logServerError('Fetch drill pack error', error)

    if (error instanceof PromptsMismatchError || error instanceof DrillGenerationError) {
      const info = voiceErrorMessage(error.code)
      return apiError(ApiErrorCode.UPSTREAM_ERROR, info.message, { code: error.code, retryable: info.retryable }, info.status)
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid query parameters' }, { status: 400 })
    }

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json({ error: 'Failed to fetch drill pack' }, { status: 500 })
  }
}

export const GET = withClientSignal(handleGET)
