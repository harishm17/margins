/**
 * API route listing the signed-in user's jobs that are still running
 * GET /api/jobs?active=1[&projectId=...][&types=generate_content,extract_topics]
 *
 * A page that was refreshed mid-job calls this to find the jobs to follow again.
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'
import { JOB_STATUS_SELECT, serializeJob } from '@/lib/jobs/status'
import {
  apiInternal,
  apiInvalidInput,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_JOBS = 100

export async function GET(request: NextRequest) {
  try {
    const session = await requireAuth()
    const query = request.nextUrl.searchParams

    if (query.get('active') !== '1') {
      return apiInvalidInput('Only active=1 is supported')
    }

    const projectId = query.get('projectId') || undefined
    const jobTypes = (query.get('types') || '')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean)

    const jobs = await prisma.processingJob.findMany({
      where: {
        userId: session.user.id,
        status: { in: ACTIVE_JOB_STATUSES },
        ...(projectId ? { projectId } : {}),
        ...(jobTypes.length > 0 ? { jobType: { in: jobTypes } } : {}),
      },
      select: JOB_STATUS_SELECT,
      orderBy: { createdAt: 'asc' },
      take: MAX_ACTIVE_JOBS,
    })

    return NextResponse.json({ jobs: jobs.map(serializeJob) })
  } catch (error) {
    logServerError('Active jobs error', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to list jobs')
  }
}
