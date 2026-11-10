/**
 * Practice progress, stored on the server so it follows the student across devices.
 * GET  /api/topics/[topicId]/practice-progress  - the progress on the topic's current practice problems
 * POST /api/topics/[topicId]/practice-progress  - store one problem's solved, shown, hinted and checked steps and
 *   rungs; the steps that finish with it, and those whose first-try record is already decided, are written as evidence
 *   (spec §5.6, §18.4). A state that cannot follow the stored one (a rung going down) is refused with 400; Connect or
 *   deeper help, or a shown answer, on a step with no attempt is refused with 409 ATTEMPT_FIRST. Reading the progress
 *   writes the evidence of misses left open on an earlier day.
 */

import { logServerError } from '@/lib/ops/log'
import { record } from '@/lib/api/fields'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { loadPracticeProgress, savePracticeProgress } from '@/lib/learning/practice-server'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import {
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const steps = z.array(z.number().int().min(0).max(200)).max(200)

const saveSchema = z.object({
  problemIndex: z.number().int().min(0).max(200),
  // The problem's title when the student worked on it: a practice that was rewritten starts clean.
  problemTitle: z.string().max(500),
  solvedSteps: steps,
  revealedSteps: steps,
  hintedSteps: steps,
  // Absent from a browser that predates rungs: the problem is stored as before and writes no evidence.
  attemptedSteps: steps.optional(),
  firstTrySteps: steps.optional(),
  maxRungs: record(z.number().int().min(0).max(5), 200, 4).optional(),
  missRungs: record(z.number().int().min(0).max(5), 200, 4).optional(),
  trippedUp: z.string().max(500).optional(),
  // Progress that was kept in the browser before the server stored it, uploaded once.
  migrated: z.boolean().optional(),
})

async function ownedTopic(userId: string, topicId: string) {
  return prisma.topic.findFirst({
    where: { id: topicId, project: { userId } },
    select: { id: true, projectId: true },
  })
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const { topicId } = await params
    if (!(await ownedTopic(session.user.id, topicId))) return apiNotFound('Topic not found')
    return NextResponse.json({ problems: await loadPracticeProgress(session.user.id, topicId, await studentTimeZone()) })
  } catch (error) {
    logServerError('Practice progress read error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load practice progress')
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { topicId } = await params
    const topic = await ownedTopic(session.user.id, topicId)
    if (!topic) return apiNotFound('Topic not found')

    const parsed = await readJson(request, saveSchema)
    if (!parsed.ok) return parsed.response

    const result = await savePracticeProgress(session.user.id, topic, { ...parsed.data, timeZone: await studentTimeZone() })
    if (result.status === 'invalid') return apiInvalidInput(result.reason)
    if (result.status === 'attempt_first') {
      return NextResponse.json({ error: 'Check an answer first, or say you don\'t know.', code: 'ATTEMPT_FIRST' }, { status: 409 })
    }
    if (result.status === 'stale') {
      // The practice was rewritten or removed since the student started: the browser reloads it.
      return NextResponse.json({ error: 'That problem is no longer in this practice.', code: 'STALE_PRACTICE' }, { status: 409 })
    }
    return NextResponse.json({ completed: result.completed, completedNow: result.completedNow, score: result.score })
  } catch (error) {
    logServerError('Practice progress save error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save practice progress')
  }
}
