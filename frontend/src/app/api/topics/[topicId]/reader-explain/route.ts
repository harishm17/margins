/**
 * "Explain this passage" in the reader (spec §5.2, §6, §18.6).
 * POST /api/topics/[topicId]/reader-explain { chunkId, take } | { chunkId, cantParse: true } | { noteId, answer } | { noteId, dontKnow: true }
 * The student's own take comes first: at least 8 characters, or the one-tap "I can't parse any of it". The
 * tutor then answers about that passage only and ends with one check question; the exchange is stored as a
 * margin note of kind question and the passage's concepts get level-3 evidence. The second "I can't parse any of
 * it" on a passage is answered with a plain restatement.
 * The answer form takes the student's answer to a check question (or "I don't know") and replies with a verdict:
 * the note stored (kind answer) comes back with `verdict`. A passage gets four tutor replies a local day.
 * 10 a minute per user (each one is a model call). When the tutor cannot answer, nothing is stored and the body
 * says why.
 */

import { readJson } from '@/lib/api/read-json'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { tutorFailure } from '@/lib/api/tutor-failure'
import { TutorUnavailableError } from '@/lib/ai-service/tutor'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { answerReaderCheck, explainPassage } from '@/lib/reader/reader-server'
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
const explainLimiter = createRateLimiter({ name: 'reader-explain', limit: 10, windowMs: 60_000 })

const explainSchema = z.object({
  chunkId: z.string().min(1).max(100),
  take: z.string().max(4000).optional(),
  cantParse: z.boolean().optional(),
})
const answerSchema = z.object({
  noteId: z.string().uuid(),
  answer: z.string().max(4000).optional(),
  dontKnow: z.boolean().optional(),
})
const bodySchema = z.union([answerSchema, explainSchema])

const LIMIT_MESSAGE = 'You have had four replies on this passage today. Read it again, and come back to ask more tomorrow.'

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response

    const cantParse = 'cantParse' in parsed.data && parsed.data.cantParse === true
    const rate = await explainLimiter.check(auth.user.id)
    if (!rate.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'You are asking quickly. Wait a moment, then try again.', { code: 'RATE_LIMITED', retryable: true }, 429)
      response.headers.set('Retry-After', String(rate.retryAfterSeconds))
      return response
    }

    if ('noteId' in parsed.data) {
      const answered = await answerReaderCheck(auth.user.id, topicId, {
        noteId: parsed.data.noteId,
        answer: parsed.data.answer,
        dontKnow: parsed.data.dontKnow,
        timeZone: await studentTimeZone(),
      })
      if (answered.status === 'not_found') return apiNotFound('Question not found')
      if (answered.status === 'invalid') return apiInvalidInput(answered.message)
      if (answered.status === 'answered') return apiError(ApiErrorCode.CONFLICT, 'You have already answered that question.', { code: 'ALREADY_ANSWERED' }, 409)
      if (answered.status === 'limit') return apiError(ApiErrorCode.RATE_LIMITED, LIMIT_MESSAGE, { code: 'PASSAGE_DAILY_LIMIT', retryable: false }, 429)
      return NextResponse.json({ note: answered.note, verdict: answered.verdict })
    }
    const result = await explainPassage({
      userId: auth.user.id,
      topicId,
      chunkId: parsed.data.chunkId,
      take: parsed.data.take ?? '',
      cantParse,
      timeZone: await studentTimeZone(),
    })
    if (result.status === 'not_found') return apiNotFound('Passage not found')
    if (result.status === 'invalid') return apiInvalidInput(result.message)
    if (result.status === 'limit') return apiError(ApiErrorCode.RATE_LIMITED, LIMIT_MESSAGE, { code: 'PASSAGE_DAILY_LIMIT', retryable: false }, 429)
    return NextResponse.json({ note: result.note })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof TutorUnavailableError) return tutorFailure(error)
    console.error('Reader explain error:', error)
    return apiInternal('The tutor could not answer')
  }
}

export const POST = withClientSignal(handlePOST)
