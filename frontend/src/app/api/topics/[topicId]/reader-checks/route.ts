/**
 * A "Quick check" check in the reader, graded by the student (spec §5.2).
 * POST /api/topics/[topicId]/reader-checks { claimId, grade: 'got_it' | 'partly' | 'missed' }
 * Level-2 evidence with the student's own grade, for display: it never moves the memory. Recorded once per claim:
 * the answer says `recorded: false` when the check was graded before.
 * GET  /api/topics/[topicId]/reader-checks?claimId= - the sentence in the student's file and its page, asked for when
 * the student shows the source (it is not sent with the reading).
 * GET  /api/topics/[topicId]/reader-checks?conceptId= - { chunkIds }: the passages of the reader that hold the claims of that
 * concept, in reading order. The reader opened for an idea (`?focus=`) marks them "Focus here" and scrolls to the first.
 */

import { readJson } from '@/lib/api/read-json'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { conceptPassageIds } from '@/lib/reader/concept-passages'
import { recordReaderCheck, revealCheckSource } from '@/lib/reader/reader-server'
import { apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ claimId: z.string().min(1).max(100), grade: z.enum(['got_it', 'partly', 'missed']) })

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const result = await recordReaderCheck({ userId: auth.user.id, topicId, claimId: parsed.data.claimId, grade: parsed.data.grade, timeZone: await studentTimeZone() })
    if (result.status === 'not_found') return apiNotFound('Check not found')
    return NextResponse.json({ ok: true, recorded: result.recorded })
  } catch (error) {
    console.error('Reader check error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save your answer')
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const query = new URL(request.url).searchParams
    const conceptId = query.get('conceptId')
    if (conceptId) return NextResponse.json({ chunkIds: await conceptPassageIds(auth.user.id, topicId, conceptId) })
    const claimId = query.get('claimId')
    if (!claimId) return apiInvalidInput('claimId or conceptId is required')
    const source = await revealCheckSource({ userId: auth.user.id, topicId, claimId })
    if (!source) return apiNotFound('Check not found')
    return NextResponse.json(source)
  } catch (error) {
    console.error('Reader check source error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the source')
  }
}

export const POST = withClientSignal(handlePOST)
