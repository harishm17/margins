/**
 * The check question that ends an Ask explanation (spec §6.3), graded by the student (§3.3).
 * POST /api/ask-checks { messageId, grade: 'got_it' | 'partly' | 'missed', confidenceLevel?, idk? }
 * Level-2 evidence, source=ask_check, with the student's own grade, for display: it never moves the memory.
 * The answer says `recorded: false` when the card was graded before or names no concept of the course.
 * POST /api/ask-checks/reveal { messageId, attempt?, idk? } - the student's attempt, then the answer and explanation.
 * GET  /api/ask-checks?messageId= - the answer and explanation again after a reload.
 * The answer is never sent with the reply, and the server returns it (and takes a grade) only once it holds the
 * student's attempt or "I don't know".
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { ANSWER_FIRST, recordAskCheck, revealAskCheck } from '@/lib/ask/ask-check'
import { CONFIDENCE_LEVELS } from '@/lib/learning/calibration'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError, zodDetails } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  messageId: z.string().uuid(),
  grade: z.enum(['got_it', 'partly', 'missed']),
  confidenceLevel: z.enum(CONFIDENCE_LEVELS.map((level) => level.id) as [string, ...string[]]).optional(),
  idk: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))
    const result = await recordAskCheck({
      userId: auth.user.id,
      messageId: parsed.data.messageId,
      grade: parsed.data.grade,
      confidenceLevel: parsed.data.confidenceLevel as (typeof CONFIDENCE_LEVELS)[number]['id'] | undefined,
      dontKnow: parsed.data.idk === true,
      timeZone: await studentTimeZone(),
    })
    if (result.status === 'not_found') return apiNotFound('Question not found')
    if (result.status === 'attempt_required') return apiInvalidInput(ANSWER_FIRST)
    return NextResponse.json({ ok: true, recorded: result.recorded, grade: result.grade })
  } catch (error) {
    console.error('Ask check error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save your answer')
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const messageId = new URL(request.url).searchParams.get('messageId')
    if (!messageId || !z.string().uuid().safeParse(messageId).success) return apiInvalidInput('messageId is required')
    const revealed = await revealAskCheck({ userId: auth.user.id, messageId })
    if (revealed.status === 'not_found') return apiNotFound('Question not found')
    if (revealed.status === 'attempt_required') return apiInvalidInput(ANSWER_FIRST)
    return NextResponse.json({ answer: revealed.answer, explanation: revealed.explanation })
  } catch (error) {
    console.error('Ask check reveal error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load the answer')
  }
}
