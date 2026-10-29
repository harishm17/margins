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
})

export async function POST(
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

    const body = await request.json()
    const validation = updateProgressSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error },
        { status: 400 }
      )
    }

    // Upsert progress
    const progress = await prisma.topicProgress.upsert({
      where: {
        topicId_userId: {
          topicId,
          userId: session.user.id,
        },
      },
      update: {
        ...validation.data,
        lastAccessedAt: new Date(),
      },
      create: {
        topicId,
        userId: session.user.id,
        notesCompleted: validation.data.notesCompleted || false,
        examplesCompleted: validation.data.examplesCompleted || false,
        quizCompleted: validation.data.quizCompleted || false,
        quizScore: validation.data.quizScore ?? null,
        lastAccessedAt: new Date(),
      },
    })

    return NextResponse.json({ progress })
  } catch (error) {
    console.error('Update progress error:', error)

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
    console.error('Fetch progress error:', error)

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
