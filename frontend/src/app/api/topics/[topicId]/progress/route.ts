import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { applyPendingQuizResults } from '@/lib/learning/quiz-submissions'
/**
 * API route for topic progress tracking
 * POST /api/topics/[topicId]/progress - Update progress
 * GET /api/topics/[topicId]/progress - Get progress
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'

const updateProgressSchema = z.object({
  notesCompleted: z.boolean().optional(),
  examplesCompleted: z.boolean().optional(),
  quizCompleted: z.boolean().optional(),
  quizScore: z.number().min(0).max(100).optional(),
  // "I've read it" in the reader: stamps readAt (the first time) and counts as the notes being read.
  readAt: z.literal(true).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { topicId } = await params

    // Verify topic ownership
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
    })

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    const validation = await readJson(request, updateProgressSchema)
    if (!validation.ok) return validation.response

    // Upsert progress
    const { readAt: markRead, ...fields } = validation.data
    const now = new Date()
    // Any "mark as read" (the reader's, or the notes view's) stamps readAt, so a topic read after v3 is never taken for one read before.
    const marksRead = !!markRead || fields.notesCompleted === true
    const read = markRead ? { notesCompleted: true } : {}
    const progress = await prisma.topicProgress.upsert({
      where: {
        topicId_userId: {
          topicId,
          userId: session.user.id,
        },
      },
      update: {
        ...fields,
        ...read,
        lastAccessedAt: now,
      },
      create: {
        topicId,
        userId: session.user.id,
        ...(marksRead ? { readAt: now } : {}),
        notesCompleted: validation.data.notesCompleted || markRead || false,
        examplesCompleted: validation.data.examplesCompleted || false,
        quizCompleted: validation.data.quizCompleted || false,
        quizScore: validation.data.quizScore ?? null,
        lastAccessedAt: new Date(),
      },
    })

    // The first time the notes are complete is when a topic read before the learning path counts as learned.
    if (progress.notesCompleted && !progress.notesCompletedAt) {
      await prisma.topicProgress.updateMany({ where: { topicId, userId: session.user.id, notesCompletedAt: null }, data: { notesCompletedAt: now } })
      progress.notesCompletedAt = now
    }

    // The first "I've read it" stands; reading again does not move readAt.
    if (marksRead && !progress.readAt) {
      await prisma.topicProgress.updateMany({ where: { topicId, userId: session.user.id, readAt: null }, data: { readAt: now } })
      progress.readAt = now
    }

    return NextResponse.json({ progress })
  } catch (error) {
    logServerError('Update progress error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to update progress' },
      { status: 500 }
    )
  }
}

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership
    const topic = await prisma.topic.findFirst({
      where: {
        id: topicId,
        project: {
          userId: session.user.id,
        },
      },
    })

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    // A quiz that finished grading while the student was away counts first.
    await applyPendingQuizResults(session.user.id)
    // Fetch progress
    const progress = await prisma.topicProgress.findUnique({
      where: {
        topicId_userId: {
          topicId,
          userId: session.user.id,
        },
      },
    })

    return NextResponse.json({
      progress: progress || {
        notesCompleted: false,
        examplesCompleted: false,
        quizCompleted: false,
        quizScore: null,
      },
    })
  } catch (error) {
    logServerError('Fetch progress error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch progress' },
      { status: 500 }
    )
  }
}
