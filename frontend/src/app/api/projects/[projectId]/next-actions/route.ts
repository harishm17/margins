import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { nextActionsFromStep, setupNextAction } from '@/lib/learning/next-actions'
import { nextStepForCourse } from '@/lib/learning/next-step'
import { conceptTopicsOf, dueTopicsOf } from '@/server/queries/course'
import { getPlanData } from '@/server/queries/plan'
import { resolveTimeZone } from '@/lib/learning/time-zone'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params

    const tz = new URL(request.url).searchParams.get('tz')
    const timeZone = resolveTimeZone(tz)
    const data = await getPlanData(auth.user.id, projectId, timeZone)
    if (!data) {
      return apiNotFound('Project not found')
    }

    // While the course is being set up the next action is the setup step; after that, today's plan.
    const setup = setupNextAction(projectId, data.course.setup, data.course.topics.length)
    const now = new Date()
    const step = nextStepForCourse({
      courseId: projectId,
      setup: data.course.setup,
      plan: data.plan,
      due: dueTopicsOf(data.course.topics, now, timeZone),
      now,
      timeZone,
      conceptTopicIds: conceptTopicsOf(data.course.topics),
    })
    const actions = setup ? [setup] : nextActionsFromStep(step, data.plan)
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      actions,
    })
  } catch (error) {
    console.error('Next actions error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load next actions')
  }
}
