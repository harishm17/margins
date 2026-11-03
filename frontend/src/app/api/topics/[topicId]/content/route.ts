/**
 * API route for topic content
 * GET /api/topics/[topicId]/content?type=section_notes
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import type { Prisma } from '@prisma/client'
import { toPublicContentData } from '@/lib/learning/quiz-questions'
import { explainerAccess } from '@/lib/learning/explainer-server'
import { CONTENT_TYPE_BY_KIND } from '@/features/topic/types'

const NOTES_TYPE = CONTENT_TYPE_BY_KIND.notes

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params
    const { searchParams } = new URL(request.url)
    const contentType = searchParams.get('type')

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

    // The lesson notes are the explainer, and the explainer is gated (spec §5.4): before a recall (or the
    // thin-source unlock) they are neither sent when asked for nor included in the list of everything.
    const access = await explainerAccess(session.user.id, topicId)
    const notesOpen = access?.open === true
    if (contentType === NOTES_TYPE && !notesOpen) {
      return NextResponse.json(
        { error: 'Try recalling this topic first. The explainer opens after that.', code: 'EXPLAINER_LOCKED' },
        { status: 403 }
      )
    }

    // Build where clause
    const where: Prisma.TopicContentWhereInput = { topicId }
    if (contentType) {
      where.contentType = contentType
    } else if (!notesOpen) {
      where.contentType = { not: NOTES_TYPE }
    }

    // Fetch content
    const rows = await prisma.topicContent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        contentType: true,
        contentData: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    // Quiz answer keys stay on the server until the student submits.
    const content = rows.map((row) => ({
      ...row,
      contentData: toPublicContentData(row.contentType, row.contentData),
    }))

    // If specific type requested, return single object
    if (contentType) {
      return NextResponse.json({
        content: content[0] || null,
      })
    }

    // Otherwise return all content types
    return NextResponse.json({ content })
  } catch (error) {
    console.error('Fetch content error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch content' },
      { status: 500 }
    )
  }
}
