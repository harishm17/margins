import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { isValidTimeZone } from '@/lib/learning/study-plan-time'
import { topicsConfirmed } from '@/lib/course-setup'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { getPlanData } from '@/server/queries/plan'

export const dynamic = 'force-dynamic'

// tz is an IANA time zone name such as America/Chicago: the plan is laid out in the student's own days.
const querySchema = z.object({
  tz: z.string().max(64).optional(),
})

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireAuth()
    const { projectId } = await params
    const searchParams = new URL(request.url).searchParams
    const parsed = querySchema.safeParse({ tz: searchParams.get('tz') || undefined })
    if (!parsed.success) {
      return apiInvalidInput('Invalid query parameters')
    }
    const timeZone = parsed.data.tz ?? 'UTC'
    if (!isValidTimeZone(timeZone)) {
      return apiInvalidInput('Invalid time zone. Use an IANA name such as America/Chicago')
    }

    const data = await getPlanData(auth.user.id, projectId, timeZone)
    if (!data) {
      return apiNotFound('Project not found')
    }
    // Same rule as the Plan page: no plan until the topic list is confirmed (lib/course-setup.ts).
    if (!topicsConfirmed(data.course.setup)) {
      return apiError(ApiErrorCode.CONFLICT, 'Confirm the course topics to get a study plan', undefined, 409)
    }
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      timeZone,
      plan: data.plan,
    })
  } catch (error) {
    console.error('Study plan error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load study plan')
  }
}
