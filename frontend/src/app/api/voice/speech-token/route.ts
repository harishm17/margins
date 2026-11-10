/**
 * A short-lived token for cloud speech recognition (spec 19.12). Only for the student's own live voice session, and only
 * while they have voice time left today. `exclude` names providers whose stream refused this session (spent credit, an
 * outage): the next one is tried.
 */
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { ApiErrorCode, apiError, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'
import { CLOUD_SPEECH_PROVIDERS, CloudSpeechError, cloudSpeechConfigured, mintCloudSpeechGrant } from '@/lib/voice/cloud-speech'
import { courseTermsForTopics, sessionTopicIds } from '@/lib/voice/course-terms'
import { getVoiceUsage } from '@/lib/voice/usage-query'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  sessionId: z.string().min(1).max(100),
  exclude: z.array(z.enum(CLOUD_SPEECH_PROVIDERS as unknown as [string, ...string[]])).max(5).optional(),
})

// A session opens one recognition stream, and a new one after a dropped connection, a paused mic or a provider that
// refused. Twenty in ten minutes is far past that; it stops a runaway loop from minting tokens.
const tokenLimiter = createRateLimiter({ name: 'speech-token', limit: 20, windowMs: 10 * 60_000 })

const unavailable = (status: number) => apiError(ApiErrorCode.UPSTREAM_ERROR, 'Cloud speech is not available', undefined, status)

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!cloudSpeechConfigured()) return unavailable(503)
    const parsed = await readJson(request, bodySchema)
    if (!parsed.ok) return parsed.response

    const limit = await tokenLimiter.check(auth.user.id)
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
    const grant = await mintCloudSpeechGrant({
      maxSessionSeconds: usage.remainingSeconds,
      language: session.language,
      terms,
      exclude: parsed.data.exclude,
    })
    return NextResponse.json(grant, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof CloudSpeechError) return unavailable(error.status)
    console.error('Speech token error:', error)
    return unavailable(502)
  }
}
