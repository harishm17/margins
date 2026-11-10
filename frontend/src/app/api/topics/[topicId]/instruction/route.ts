/**
 * An instruction the student was shown in the browser (spec 18.5): a page pointer opened, a gap-explainer section or the
 * full explainer read. The reader opened with `focus=` is recorded by the topic page itself, on the server.
 * POST /api/topics/[topicId]/instruction { kind, conceptIds, ref }
 * Writes one weight-0 `source=instruction` event per concept, once per (item key, local day): `recorded: false` when it was
 * already written today. It never moves a card, mastery or a due date; it tells next activity that the idea was shown.
 */

import { logServerError } from '@/lib/ops/log'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { recordInstruction } from '@/lib/learning/instruction-server'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { apiInternal, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const instructionLimiter = createRateLimiter({ name: 'instruction', limit: 30, windowMs: 60_000 })

const bodySchema = z.object({
  kind: z.enum(['pointer', 'gap_explainer', 'full_explainer', 'worked_example', 'reveal', 'restatement', 'voice_explain']),
  conceptIds: z.array(z.string().min(1).max(100)).min(1).max(20),
  ref: z.string().min(1).max(200),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const rate = await instructionLimiter.check(auth.user.id)
    if (!rate.ok) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } })
    }
    const { topicId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response
    const result = await recordInstruction(prisma, {
      userId: auth.user.id,
      topicId,
      kind: parsed.data.kind,
      conceptIds: parsed.data.conceptIds,
      ref: parsed.data.ref,
      timeZone: await studentTimeZone(),
    })
    if (result.status === 'invalid') return apiNotFound('Topic not found')
    return NextResponse.json({ ok: true, recorded: result.status === 'recorded' })
  } catch (error) {
    logServerError('Instruction error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save that')
  }
}
