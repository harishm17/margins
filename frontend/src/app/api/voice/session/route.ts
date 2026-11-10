import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { assertQuota, quota, quotaErrorResponse, quotaResponse } from '@/lib/api/quota'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { ownedProject, ownedTopic } from '@/server/owned'
import { VoiceQuestion } from '@/lib/voice/concept'
import { courseTermsForTopics, sessionTopicIds } from '@/lib/voice/course-terms'
import { normalizeFocus } from '@/lib/voice/coach-prompt'
import { cloudSpeechConfigured } from '@/lib/voice/cloud-speech'
import { buildSprintQuestionSet, buildTopicQuestionSet } from '@/lib/voice/drill-pack'
import {
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
  zodDetails,
} from '@/lib/api/errors'

const sessionSchema = z.object({
  mode: z.enum(['topic_drill', 'sprint']).default('topic_drill'),
  // `topic_conversation` is gone for new sessions. A tab opened before guided reading replaced guided notes still sends the old name.
  style: z
    .enum(['oral_quiz', 'teach_back', 'guided_reading', 'guided_notes'])
    .optional()
    .default('oral_quiz')
    .transform((style) => (style === 'guided_notes' ? 'guided_reading' : style)),
  projectId: id(),
  topicId: id().optional(),
  // The idea a teach-back starts with (the "Do it out loud" link names it).
  conceptId: z.string().max(100).optional(),
  language: z.string().max(8).regex(/^[a-z]{2,8}$/i).optional().default('en'),
  // Ignored since the coach moved to Claude (the browser chooses the voice). Still accepted.
  voice: z.string().max(50).optional().default('marin'),
  // What the student wants to concentrate on; trimmed and cut to MAX_FOCUS_CHARS.
  focus: z.string().max(2000).nullish(),
})

const patchSchema = z.object({
  sessionId: id(),
  status: z.enum(['active', 'ended', 'aborted']).optional(),
  lastDetectedLanguage: z.string().max(8).regex(/^[a-z]{2,8}$/i).nullable().optional(),
  incrementInterruptCount: z.number().int().min(0).max(20).optional(),
  // Sent every 30 seconds by an open call; keeps the session counted as live.
  heartbeat: z.boolean().optional(),
})

async function handlePOST(request: NextRequest) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const parsed = await readJson(request, sessionSchema)
    if (!parsed.ok) return parsed.response
    const payload = parsed.data

    if (payload.mode === 'topic_drill' && !payload.topicId) {
      return apiInvalidInput('topicId is required for topic drills')
    }

    if (!(await ownedProject(session.user.id, payload.projectId))) {
      return apiNotFound('Project not found')
    }

    // A sprint is over the whole course: it belongs to no topic, whatever the body says. A topic drill's topic is the
    // student's own and in this course.
    const topic = payload.mode === 'sprint' || !payload.topicId ? null : await ownedTopic(session.user.id, payload.topicId, payload.projectId)
    if (payload.mode !== 'sprint' && payload.topicId && !topic) {
      return apiNotFound('Topic not found')
    }
    const topicId = topic?.id ?? null

    const readsClaims = payload.style === 'teach_back' || payload.style === 'guided_reading'
    if (readsClaims && (payload.mode === 'sprint' || !topicId)) {
      return apiInvalidInput('Teach it back and guided reading work on one topic at a time')
    }
    // The idea must be an active one of this topic with claims; anything else is ignored (the coach picks the weakest).
    const startConcept =
      payload.style === 'teach_back' && payload.conceptId && topicId
        ? await prisma.concept.findFirst({
            where: { id: payload.conceptId, topicId, status: 'active', claims: { some: {} } },
            select: { id: true },
          })
        : null
    // Both styles are grounded in the topic's claims from the student's own pages.
    if (readsClaims && topicId) {
      const claims = await prisma.conceptClaim.count({ where: { concept: { topicId, status: 'active' } } })
      if (claims === 0) {
        return NextResponse.json(
          { error: { code: 'CONFLICT', message: 'This topic has no claims from your pages yet' }, requiresClaims: true },
          { status: 422 }
        )
      }
    }

    let questionSet: VoiceQuestion[] = []

    if (readsClaims) {
      // These styles read the topic's claims through their tools; there is no question bank.
    } else if (payload.mode === 'topic_drill' && topicId) {
      questionSet = await buildTopicQuestionSet(topicId, session.user.id)
    } else {
      questionSet = await buildSprintQuestionSet(payload.projectId, session.user.id)
    }

    const requiresQuestionSet = payload.mode === 'sprint' || payload.style === 'oral_quiz'
    if (requiresQuestionSet && questionSet.length === 0) {
      return NextResponse.json(
        { error: { code: 'CONFLICT', message: 'No conceptual questions available' }, requiresGeneration: true },
        { status: 422 }
      )
    }

    const voiceSession = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, session.user, 'voiceSessions')
      return tx.voiceDrillSession.create({
        data: {
          userId: session.user.id,
          projectId: payload.projectId,
          topicId,
          mode: payload.mode,
          language: payload.language || 'en',
          voice: payload.voice || 'marin',
          style: payload.style,
          focus: normalizeFocus(payload.focus),
          questionSet,
          ...(startConcept ? { coachState: { teach: { current: startConcept.id, concepts: {} } } } : {}),
          metrics: { entries: [] },
          status: 'active',
        },
      })
    })

    // The topic's key terms, for the coach prompt (the turn route builds the same list) and for on-device recognition (spec 19.5).
    const courseTerms = await courseTermsForTopics(session.user.id, sessionTopicIds({ topicId, questionSet }))

    return NextResponse.json({
      sessionId: voiceSession.id,
      courseTerms,
      // The browser asks /api/voice/speech-token for a recognition token when this is true (spec 19.12).
      cloudSpeech: cloudSpeechConfigured(),
      questionCount: questionSet.length,
      mode: payload.mode,
      style: payload.style,
      focus: voiceSession.focus,
    })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    logServerError('Create voice session error', error)

    if (error instanceof z.ZodError) {
      return apiInvalidInput('Invalid input', zodDetails(error))
    }

    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }

    return apiInternal('Failed to create voice session')
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const parsed = await readJson(request, patchSchema)
    if (!parsed.ok) return parsed.response
    const payload = parsed.data

    const session = await prisma.voiceDrillSession.findFirst({
      where: {
        id: payload.sessionId,
        userId: auth.user.id,
      },
      select: {
        id: true,
        interruptCount: true,
        endedAt: true,
      },
    })

    if (!session) {
      return apiNotFound('Session not found')
    }

    // An ended session stays ended: a late status update must not reopen it.
    if (session.endedAt && payload.status === 'active') {
      return NextResponse.json({ session: { id: session.id, endedAt: session.endedAt } })
    }

    const nextInterruptCount = payload.incrementInterruptCount
      ? session.interruptCount + payload.incrementInterruptCount
      : session.interruptCount

    const updated = await prisma.voiceDrillSession.update({
      where: { id: payload.sessionId },
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.lastDetectedLanguage !== undefined
          ? { lastDetectedLanguage: payload.lastDetectedLanguage }
          : {}),
        ...(payload.status === 'ended' || payload.status === 'aborted'
          ? { endedAt: session.endedAt ?? new Date() }
          : {}),
        ...(payload.heartbeat ? { lastSeenAt: new Date() } : {}),
        ...(payload.incrementInterruptCount
          ? { interruptCount: nextInterruptCount }
          : {}),
      },
      select: {
        id: true,
        status: true,
        interruptCount: true,
        lastDetectedLanguage: true,
        endedAt: true,
      },
    })

    return NextResponse.json({ session: updated })
  } catch (error) {
    logServerError('Patch voice session error', error)

    if (error instanceof z.ZodError) {
      return apiInvalidInput('Invalid input', zodDetails(error))
    }
    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }
    return apiInternal('Failed to update voice session')
  }
}

export const POST = withClientSignal(handlePOST)
