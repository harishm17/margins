/**
 * The source reader's text (spec §5.2).
 * GET /api/topics/[topicId]/reader - the topic's primary chunks in document order with their ids, pages and
 * file, the focus questions, the "Quick check" checks, the student's margin notes, and which passages
 * the warm-up marks Focus here. Overlap between chunks is already removed.
 */

import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { loadReader } from '@/lib/reader/load-reader'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const reader = await loadReader(auth.user.id, topicId)
    if (!reader) return apiNotFound('Topic not found')
    return NextResponse.json(reader)
  } catch (error) {
    logServerError('Reader error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the reading')
  }
}
