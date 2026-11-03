import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { VoiceQuestion } from '@/lib/voice/concept'
import { courseTermsForTopics, sessionTopicIds } from '@/lib/voice/course-terms'
import { normalizeFocus } from '@/lib/voice/coach-prompt'
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
  projectId: z.string(),
  topicId: z.string().optional(),
  // The idea a teach-back starts with (the "Do it out loud" link names it).
  conceptId: z.string().max(100).optional(),
  language: z.string().regex(/^[a-z]{2,8}$/i).optional().default('en'),
  // Ignored since the coach moved to Claude (the browser chooses the voice). Still accepted.
  voice: z.string().optional().default('marin'),
  // What the student wants to concentrate on; trimmed and cut to MAX_FOCUS_CHARS.
  focus: z.string().nullish(),
})

const patchSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['active', 'ended', 'aborted']).optional(),
  lastDetectedLanguage: z.string().regex(/^[a-z]{2,8}$/i).nullable().optional(),
  incrementInterruptCount: z.number().int().min(0).max(20).optional(),
  // Sent every 30 seconds by an open call; keeps the session counted as live.
  heartbeat: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await requireAuth()
    const body = await request.json()
    const payload = sessionSchema.parse(body)

    if (payload.mode === 'topic_drill' && !payload.topicId) {
      return apiInvalidInput('topicId is required for topic drills')
    }

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: payload.projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return apiNotFound('Project not found')
    }

    if (payload.mode === 'topic_drill' && payload.topicId) {
      const topic = await prisma.topic.findFirst({
        where: {
          id: payload.topicId,
          projectId: payload.projectId,
          project: { userId: session.user.id },
        },
        select: { id: true },
      })

      if (!topic) {
        return apiNotFound('Topic not found')
      }
    }

    const readsClaims = payload.style === 'teach_back' || payload.style === 'guided_reading'
    if (readsClaims && (payload.mode === 'sprint' || !payload.topicId)) {
      return apiInvalidInput('Teach it back and guided reading work on one topic at a time')
    }
    // The idea must be an active one of this topic with claims; anything else is ignored (the coach picks the weakest).
    const startConcept =
      payload.style === 'teach_back' && payload.conceptId && payload.topicId
        ? await prisma.concept.findFirst({
            where: { id: payload.conceptId, topicId: payload.topicId, status: 'active', claims: { some: {} } },
            select: { id: true },
          })
        : null
    // Both styles are grounded in the topic's claims from the student's own pages.
    if (readsClaims && payload.topicId) {
      const claims = await prisma.conceptClaim.count({ where: { concept: { topicId: payload.topicId, status: 'active' } } })
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
    } else if (payload.mode === 'topic_drill' && payload.topicId) {
      questionSet = await buildTopicQuestionSet(payload.topicId, session.user.id)
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

    const voiceSession = await prisma.voiceDrillSession.create({
      data: {
        userId: session.user.id,
        projectId: payload.projectId,
        topicId: payload.topicId ?? null,
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

    // The topic's key terms, for the coach prompt (the turn route builds the same list) and for on-device recognition (spec 19.5).
    const courseTerms = await courseTermsForTopics(sessionTopicIds({ topicId: payload.topicId ?? null, questionSet }))

    return NextResponse.json({
      sessionId: voiceSession.id,
      courseTerms,
      questionCount: questionSet.length,
      mode: payload.mode,
      style: payload.style,
      focus: voiceSession.focus,
    })
  } catch (error) {
    console.error('Create voice session error:', error)

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
    const body = await request.json()
    const payload = patchSchema.parse(body)

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
    console.error('Patch voice session error:', error)

    if (error instanceof z.ZodError) {
      return apiInvalidInput('Invalid input', zodDetails(error))
    }
    if (isUnauthorizedError(error)) {
      return apiUnauthorized()
    }
    return apiInternal('Failed to update voice session')
  }
}
