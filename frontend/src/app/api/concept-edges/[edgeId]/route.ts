/**
 * Answer a suggested link between two concepts (spec §9).
 * PATCH /api/concept-edges/[edgeId] { status: 'confirmed' | 'rejected' }
 *   Marks the link as the student's own decision. Rejecting an encompasses link also takes back the implicit credit it
 *   gave this student (lib/learning/concept-edge.ts). Only the owner of the course can answer; anyone else gets a 404.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { setEdgeStatus } from '@/lib/learning/concept-edge'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ status: z.enum(['confirmed', 'rejected']) })

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ edgeId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { edgeId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response

    const result = await setEdgeStatus({ userId: auth.user.id, edgeId, status: parsed.data.status, timeZone: await studentTimeZone() })
    if (result.status === 'not_found') return apiNotFound('Link not found')
    return NextResponse.json({ status: parsed.data.status })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Concept edge error:', error)
    return apiInternal('Could not save your answer')
  }
}
