/**
 * POST /api/ask-checks/reveal { messageId, attempt?, idk? }
 * The student's attempt at an Ask check card (their words, or "I don't know"), stored on the server, and then the
 * answer and explanation. Without an attempt (or one stored earlier) the answer is not returned (spec P1).
 */

import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { ANSWER_FIRST, revealAskCheck } from '@/lib/ask/ask-check'
import { apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  messageId: z.string().uuid(),
  attempt: z.string().max(2000).optional(),
  idk: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const revealed = await revealAskCheck({ userId: auth.user.id, messageId: parsed.data.messageId, attempt: parsed.data.attempt, dontKnow: parsed.data.idk === true })
    if (revealed.status === 'not_found') return apiNotFound('Question not found')
    if (revealed.status === 'attempt_required') return apiInvalidInput(ANSWER_FIRST)
    return NextResponse.json({ answer: revealed.answer, explanation: revealed.explanation })
  } catch (error) {
    console.error('Ask check reveal error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the answer')
  }
}
