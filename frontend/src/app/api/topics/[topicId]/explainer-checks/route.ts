/**
 * A "check yourself" block graded by the student (spec §5.4, §3.3).
 * POST /api/topics/[topicId]/explainer-checks { question, grade: 'got_it' | 'partly' | 'missed', idk?, conceptId?, conceptIds? }
 * Level-2 evidence, source=example, with the student's own grade, for display: it never moves the memory. Recorded once
 * per question: the answer says `recorded: false` when it was graded before, or when the question names no concept of
 * the topic to file it under.
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { recordExplainerCheck } from '@/lib/learning/explainer-server'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  grade: z.enum(['got_it', 'partly', 'missed']),
  idk: z.boolean().optional(),
  conceptId: z.string().min(1).max(100).optional(),
  // A worked example's concepts: the grade is filed under each (spec 5.5).
  conceptIds: z.array(z.string().min(1).max(100)).max(10).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { topicId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const result = await recordExplainerCheck({
      userId: auth.user.id,
      topicId,
      question: parsed.data.question,
      grade: parsed.data.grade,
      idk: parsed.data.idk === true,
      conceptId: parsed.data.conceptId ?? null,
      conceptIds: parsed.data.conceptIds,
      timeZone: await studentTimeZone(),
    })
    if (result.status === 'not_found') return apiNotFound('Topic not found')
    return NextResponse.json({ ok: true, recorded: result.recorded })
  } catch (error) {
    logServerError('Explainer check error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save your answer')
  }
}
