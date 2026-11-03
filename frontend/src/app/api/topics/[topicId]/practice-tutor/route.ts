/**
 * "Ask about my working" on a practice step (spec §5.6, §6.1, §6.2).
 * GET  /api/topics/[topicId]/practice-tutor?problemIndex&problemTitle&stepIndex - where the step's conversation stands.
 * POST /api/topics/[topicId]/practice-tutor - one submission, one event on the step's hint ladder:
 *   a checked answer, "I don't know", an opened hint, a question about the student's working, "What is this
 *   asking?", "Show me a worked example" or "Show answer". Only the worked example and the two questions call the AI
 *   service (20 a minute per user). Connect, Structure, the worked example and Show answer need one attempt on the step:
 *   without it the answer is 409 ATTEMPT_FIRST (spec 18.4). When the tutor cannot answer, the state is left as it was and
 *   the body says why (error.details.code). A miss comes back with what to read next (`help`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { TutorUnavailableError } from '@/lib/ai-service/tutor'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { readPracticeTutorState, runPracticeTutor } from '@/lib/tutor/practice-tutor'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { tutorFailure } from '@/lib/api/tutor-failure'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
  zodDetails,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

// A model call, and often two.
const tutorLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 })

const bodySchema = z.object({
  problemIndex: z.number().int().min(0).max(200),
  problemTitle: z.string().max(500),
  stepIndex: z.number().int().min(0).max(200),
  event: z.enum(['check', 'hint', 'ask', 'clarify', 'show_worked', 'dont_know', 'reveal']),
  answer: z.string().max(2000).optional(),
  hintIndex: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  working: z.string().max(4000).optional(),
  message: z.string().max(4000).optional(),
  attempts: z.array(z.string().max(2000)).max(20).optional(),
  missKind: z.enum(['cue_miss', 'discrimination', 'execution', 'careless', 'misconception']).optional(),
})

const CALLS_THE_TUTOR = new Set(['ask', 'clarify', 'show_worked'])

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const userId = session.user.id
    const { topicId } = await params
    const topic = await prisma.topic.findFirst({
      where: { id: topicId, project: { userId } },
      select: { id: true, projectId: true },
    })
    if (!topic) return apiNotFound('Topic not found')

    const body = await request.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))

    // Every model call counts toward the limit; a request that turns out invalid or stale does not.
    const admit = CALLS_THE_TUTOR.has(parsed.data.event)
      ? () => {
          const limit = tutorLimiter.check(userId)
          return limit.ok ? ({ ok: true } as const) : ({ ok: false, retryAfterSeconds: limit.retryAfterSeconds } as const)
        }
      : undefined
    const result = await runPracticeTutor(userId, topic, parsed.data, { timeZone: await studentTimeZone(), admit })
    if (result.status === 'stale') {
      return apiError(ApiErrorCode.CONFLICT, 'That problem is no longer in this practice.', { code: 'STALE_PRACTICE' }, 409)
    }
    if (result.status === 'attempt_first') {
      return apiError(ApiErrorCode.CONFLICT, 'Check an answer first, or say you don\'t know.', { code: 'ATTEMPT_FIRST' }, 409)
    }
    if (result.status === 'not_allowed') {
      return apiError(ApiErrorCode.CONFLICT, 'Check an answer first.', { code: 'NOT_ALLOWED' }, 409)
    }
    if (result.status === 'rate_limited') {
      const response = apiError(
        ApiErrorCode.RATE_LIMITED,
        'You are asking quickly. Wait a moment, then try again.',
        { code: 'RATE_LIMITED', retryable: true },
        429
      )
      response.headers.set('Retry-After', String(result.retryAfterSeconds))
      return response
    }
    return NextResponse.json(result.body)
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof TutorUnavailableError) return tutorFailure(error)
    console.error('Practice tutor error:', error)
    return apiInternal('The tutor could not answer')
  }
}

const stateQuery = z.object({
  problemIndex: z.coerce.number().int().min(0).max(200),
  problemTitle: z.string().max(500),
  stepIndex: z.coerce.number().int().min(0).max(200),
})

/** Where one step's conversation stands (checks seen, whether a worked example is allowed), for a page that was just opened. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await requireAuth()
    const { topicId } = await params
    const topic = await prisma.topic.findFirst({ where: { id: topicId, project: { userId: session.user.id } }, select: { id: true } })
    if (!topic) return apiNotFound('Topic not found')
    const parsed = stateQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))
    const state = await readPracticeTutorState(session.user.id, topic, parsed.data)
    if (!state) return apiError(ApiErrorCode.CONFLICT, 'That problem is no longer in this practice.', { code: 'STALE_PRACTICE' }, 409)
    const { contentId, help, ...rest } = state
    return NextResponse.json({ state: rest, contentId, ...(help ? { help } : {}) })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Practice tutor state error:', error)
    return apiInternal('The tutor state could not be read')
  }
}
