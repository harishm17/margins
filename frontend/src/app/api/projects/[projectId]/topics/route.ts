/**
 * API routes for topics
 * GET /api/projects/[projectId]/topics - List topics
 * POST /api/projects/[projectId]/topics - Create topic (manual): { name, description?, unitId? }
 *   A topic added by hand has no sources (it is taught from a search of the course files), no
 *   objectives and no prerequisites. With unitId it joins that unit as its last topic; without
 *   one it is last in the course and belongs to no unit.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { assertQuota, quota, quotaErrorResponse, quotaResponse } from '@/lib/api/quota'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { normalizeTopicOrder } from '@/lib/topics/normalize-order'

const createTopicSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(4000).optional(),
  unitId: id().nullable().optional(),
})

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Fetch topics
    const topics = await prisma.topic.findMany({
      where: { projectId },
      orderBy: { orderIndex: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        keywords: true,
        orderIndex: true,
        userConfirmed: true,
        createdAt: true,
        unitId: true,
        objectives: true,
        prerequisiteIds: true,
        estimatedMinutes: true,
      },
    })

    return NextResponse.json({ topics })
  } catch (error) {
    console.error('Fetch topics error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch topics' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { projectId } = await params

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const validation = await readJson(request, createTopicSchema)
    if (!validation.ok) return validation.response

    // Get next order index
    const maxOrder = await prisma.topic.findFirst({
      where: { projectId },
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    })

    const nextOrder = (maxOrder?.orderIndex ?? -1) + 1

    const unitId = validation.data.unitId ?? null
    if (unitId) {
      const unit = await prisma.unit.findFirst({ where: { id: unitId, projectId }, select: { id: true } })
      if (!unit) {
        return NextResponse.json({ error: 'Unit not found' }, { status: 404 })
      }
    }

    // Create topic
    const topic = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, session.user, 'topics', { projectId })
      const created = await tx.topic.create({
        data: {
          projectId,
          name: validation.data.name,
          description: validation.data.description || '',
          keywords: [],
          orderIndex: nextOrder,
          sourceMaterialIds: [],
          objectives: [],
          prerequisiteIds: [],
          unitId,
          userConfirmed: true, // Manually created topics are auto-confirmed
        },
      })
      if (!unitId) return created
      // Last in its unit, which is not the end of the course unless the unit is the last one.
      await normalizeTopicOrder(tx, projectId)
      return tx.topic.findUniqueOrThrow({ where: { id: created.id } })
    })

    return NextResponse.json({ topic })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    console.error('Create topic error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create topic' },
      { status: 500 }
    )
  }
}
