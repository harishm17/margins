/**
 * Recall and teach-back (spec §5.3).
 * POST  /api/topics/[topicId]/recall { kind: 'recall' | 'teach_back', objectiveIndex?, conceptId?, answer, idk?, abandoned?, mode? }
 *   Grades the answer against the claims of the concepts the card covers. A graded answer is stored, becomes level-0
 *   evidence (level 2 when `abandoned`: the reader or explainer was opened while the card was open) and sets
 *   recallAt. An answer too short or unclear to grade stores nothing and comes back as { status: 'ungraded',
 *   clarifyingQuestion }. "I don't remember" (`idk: true`, or a typed admission) is not graded: it is level-1 evidence on every concept
 *   of the card, and its gap explainer covers every claim of the card. A graded recall answer with a missing or incorrect claim starts the gap explainer job
 *   (explainers: lib/learning/explainer-server.ts). 10 a minute per user (each one is a model call). When the grader cannot answer the body
 *   says why, with a 503, and nothing is stored: the browser keeps what the student wrote.
 * PATCH /api/topics/[topicId]/recall { attemptId } - "Show me what I missed": the claims the answer did not cover,
 *   and level 3 on their concepts.
 */

import { readJson } from '@/lib/api/read-json'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { TutorUnavailableError } from '@/lib/ai-service/tutor'
import { tutorFailure } from '@/lib/api/tutor-failure'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { startGapExplainer } from '@/lib/learning/explainer-server'
import { MAX_RECALL_ANSWER_CHARS, revealMissed, submitRecall } from '@/lib/learning/recall-server'
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

const recallLimiter = createRateLimiter({ name: 'recall', limit: 10, windowMs: 60_000 })

const submitSchema = z.object({
  kind: z.enum(['recall', 'teach_back']),
  objectiveIndex: z.number().int().min(0).max(100).optional(),
  conceptId: z.string().min(1).max(100).optional(),
  answer: z.string().max(MAX_RECALL_ANSWER_CHARS),
  idk: z.boolean().optional(),
  abandoned: z.boolean().optional(),
  mode: z.enum(['text', 'voice']).optional(),
})

const revealSchema = z.object({ attemptId: z.string().min(1).max(100) })

async function handlePOST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const parsed = await readJson(request, submitSchema)
    if (!parsed.ok) return parsed.response

    const rate = await recallLimiter.check(auth.user.id)
    if (!rate.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'You are submitting quickly. Wait a moment, then try again.', { code: 'RATE_LIMITED', retryable: true }, 429)
      response.headers.set('Retry-After', String(rate.retryAfterSeconds))
      return response
    }

    const result = await submitRecall({
      userId: auth.user.id,
      topicId,
      kind: parsed.data.kind,
      objectiveIndex: parsed.data.objectiveIndex ?? null,
      conceptId: parsed.data.conceptId ?? null,
      answer: parsed.data.answer,
      idk: parsed.data.idk === true,
      abandoned: parsed.data.abandoned === true,
      inputMode: parsed.data.mode ?? 'text',
      timeZone: await studentTimeZone(),
    })
    switch (result.status) {
      case 'not_found':
        return apiNotFound('Topic not found')
      case 'not_ready':
        return apiError(ApiErrorCode.CONFLICT, 'Recall is not ready for this topic yet.', { code: 'RECALL_NOT_READY', retryable: false }, 409)
      case 'invalid':
        return apiInvalidInput(result.message)
      case 'ungraded':
        return NextResponse.json({ status: 'ungraded', clarifyingQuestion: result.clarifyingQuestion })
      case 'graded':
        // What the answer missed is explained in the background (spec §5.4); a failure here never costs the student their feedback.
        // An answer given with the reading open is not a recall: nothing is written for it. An "I don't remember" always gets its explainer.
        if (parsed.data.kind === 'recall' && (result.feedback.idk || !result.feedback.abandoned)) {
          // Not awaited: the answer does not wait for the job to be created (the explainer page shows it as being written meanwhile).
          void startGapExplainer({ userId: auth.user.id, attemptId: result.feedback.attemptId, quiet: true }).catch((error) => console.error('Gap explainer start error:', error))
        }
        return NextResponse.json({ status: 'graded', feedback: result.feedback })
    }
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof TutorUnavailableError) return tutorFailure(error)
    console.error('Recall error:', error)
    return apiInternal('Your answer could not be graded')
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const parsed = await readJson(request, revealSchema)
    if (!parsed.ok) return parsed.response
    const result = await revealMissed({ userId: auth.user.id, topicId, attemptId: parsed.data.attemptId, timeZone: await studentTimeZone() })
    if (result.status === 'not_found') return apiNotFound('Answer not found')
    return NextResponse.json({ revealed: result.revealed })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    console.error('Recall reveal error:', error)
    return apiInternal('Could not show what you missed')
  }
}

export const POST = withClientSignal(handlePOST)
