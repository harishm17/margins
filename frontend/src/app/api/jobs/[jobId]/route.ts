/**
 * API route for job status polling
 * GET /api/jobs/[jobId]
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { JOB_STATUS_SELECT, serializeJob } from '@/lib/jobs/status'
import {
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const session = await requireAuth()
    const { jobId } = await params

    // Fetch job and verify ownership
    const job = await prisma.processingJob.findFirst({
      where: {
        id: jobId,
        userId: session.user.id,
      },
      select: JOB_STATUS_SELECT,
    })

    if (!job) {
      return apiNotFound('Job not found')
    }

    return NextResponse.json(serializeJob(job))
  } catch (error) {
    logServerError('Job status error', error)

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to fetch job status')
  }
}
