/**
 * A short-lived token for cloud speech recognition (spec 19.12). Only for the student's own live voice session, and only
 * while they have voice time left today: the recognition session it opens ends when that time runs out.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import {
  CLOUD_SPEECH_PROVIDER,
  CloudSpeechError,
  cloudSpeechConfigured,
  cloudSpeechUrl,
  mintCloudSpeechToken,
} from '@/lib/voice/cloud-speech'
import { courseTermsForTopics, sessionTopicIds } from '@/lib/voice/course-terms'
import { getVoiceUsage } from '@/lib/voice/usage-query'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ sessionId: z.string().min(1).max(100) })

// A session opens one recognition stream, and a new one after a dropped connection or a paused mic. Twenty in ten
// minutes is far past that; it stops a runaway loop from minting tokens.
const tokenLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 })

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!cloudSpeechConfigured()) {
      return apiError(ApiErrorCode.UPSTREAM_ERROR, 'Cloud speech is not available', undefined, 503)
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return apiInvalidInput('sessionId is required')

    const limit = tokenLimiter.check(auth.user.id)
    if (!limit.ok) {
      const response = apiError(ApiErrorCode.RATE_LIMITED, 'Too many speech sessions; try again shortly', undefined, 429)
      response.headers.set('Retry-After', String(limit.retryAfterSeconds))
      return response
    }

    const session = await prisma.voiceDrillSession.findFirst({
      where: { id: parsed.data.sessionId, userId: auth.user.id },
      select: { id: true, endedAt: true, status: true, language: true, topicId: true, questionSet: true },
    })
    if (!session || session.endedAt || session.status !== 'active') return apiNotFound('No live voice session')

    const usage = await getVoiceUsage(auth.user.id)
    if (usage.remainingSeconds <= 0) {
      return apiError(ApiErrorCode.CONFLICT, 'No voice time left today', undefined, 409)
    }

    const terms = await courseTermsForTopics(sessionTopicIds(session))
    const token = await mintCloudSpeechToken({ maxSessionSeconds: usage.remainingSeconds })
    return NextResponse.json(
      {
        provider: CLOUD_SPEECH_PROVIDER,
        url: cloudSpeechUrl({ language: session.language, terms, model: process.env.ASSEMBLYAI_STREAMING_MODEL }),
        token,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof CloudSpeechError) {
      console.error('Speech token error:', error.message)
      return apiError(ApiErrorCode.UPSTREAM_ERROR, 'Cloud speech is not available', undefined, error.status)
    }
    console.error('Speech token error:', error)
    return apiError(ApiErrorCode.UPSTREAM_ERROR, 'Cloud speech is not available', undefined, 502)
  }
}
