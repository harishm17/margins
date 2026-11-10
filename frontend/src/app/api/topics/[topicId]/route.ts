/**
 * API routes for individual topics
 * PATCH /api/topics/[topicId] - Update topic: name, description, confirmed, objectives,
 *   prerequisiteIds, estimatedMinutes, the unit it belongs to (unitId, null for none), or move it
 *   to a new position with orderIndex (a position among all topics in course order; the topics
 *   around it shift to make room). Changing the unit without an orderIndex puts the topic last in
 *   that unit. A request that sets unitId also renormalises the course order (units in order, each
 *   with its topics, topics without a unit last), so a unit-aware editor can send
 *   { unitId, orderIndex } to drop a topic into a unit at a position. A request with only orderIndex
 *   moves the topic among all topics and leaves the rest alone, as it always did.
 * DELETE /api/topics/[topicId] - Delete topic (other topics stop listing it as a prerequisite)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { moveInOrder } from '@/lib/topics/ordering'
import { ownedTopic } from '@/server/owned'
import { normalizeTopicOrder } from '@/lib/topics/normalize-order'
import { cleanPrerequisites, reachesPrerequisite } from '@/lib/topics/units'

const updateTopicSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().optional(),
  userConfirmed: z.boolean().optional(),
  orderIndex: z.number().int().min(0).optional(),
  unitId: z.string().min(1).nullable().optional(),
  objectives: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
  prerequisiteIds: z.array(z.string().min(1)).max(8).optional(),
  estimatedMinutes: z.number().int().min(1).max(600).nullable().optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership through project
    const scope = await ownedTopic(session.user.id, topicId)
    const topic = scope ? await prisma.topic.findUnique({ where: { id: scope.id } }) : null

    if (!scope || !topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const validation = updateTopicSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error },
        { status: 400 }
      )
    }

    const { orderIndex, unitId, prerequisiteIds, ...fields } = validation.data

    // The unit and the prerequisites must belong to this project; prerequisites must not loop.
    if (unitId) {
      const unit = await prisma.unit.findFirst({ where: { id: unitId, projectId: topic.projectId }, select: { id: true } })
      if (!unit) return NextResponse.json({ error: 'Unit not found' }, { status: 404 })
    }
    let cleanedPrerequisites: string[] | undefined
    if (prerequisiteIds !== undefined) {
      const all = await prisma.topic.findMany({
        where: { projectId: topic.projectId },
        select: { id: true, prerequisiteIds: true },
      })
      const ids = new Set(all.map((item) => item.id))
      cleanedPrerequisites = cleanPrerequisites(topicId, prerequisiteIds, ids)
      const graph = new Map(all.map((item) => [item.id, item.prerequisiteIds]))
      if (cleanedPrerequisites.some((id) => reachesPrerequisite(graph, id, topicId))) {
        return NextResponse.json({ error: 'A topic cannot depend on a topic that depends on it' }, { status: 400 })
      }
    }

    const updatedTopic = await prisma.$transaction(async (tx) => {
      let targetIndex = orderIndex
      if (unitId !== undefined && unitId !== topic.unitId && targetIndex === undefined) {
        // Moved to another unit with no position: last in that unit (or last overall for none).
        const ordered = await tx.topic.findMany({
          where: { projectId: topic.projectId },
          orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, unitId: true },
        })
        const rest = ordered.filter((item) => item.id !== topicId)
        const lastInUnit = rest.map((item) => item.unitId).lastIndexOf(unitId)
        targetIndex = unitId === null || lastInUnit === -1 ? rest.length : lastInUnit + 1
      }
      if (targetIndex !== undefined) {
        const siblings = await tx.topic.findMany({
          where: { projectId: topic.projectId },
          orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, orderIndex: true },
        })
        const newOrder = moveInOrder(
          siblings.map((sibling) => sibling.id),
          topicId,
          targetIndex
        )
        const currentIndex = new Map(siblings.map((sibling) => [sibling.id, sibling.orderIndex]))
        for (const [index, id] of newOrder.entries()) {
          if (currentIndex.get(id) !== index) {
            await tx.topic.update({ where: { id }, data: { orderIndex: index } })
          }
        }
      }
      const updated = await tx.topic.update({
        where: { id: topicId },
        data: {
          ...fields,
          ...(unitId !== undefined ? { unitId } : {}),
          ...(cleanedPrerequisites !== undefined ? { prerequisiteIds: cleanedPrerequisites } : {}),
        },
      })
      if (unitId !== undefined) {
        await normalizeTopicOrder(tx, scope)
        return tx.topic.findUniqueOrThrow({ where: { id: topicId } })
      }
      return updated
    })

    return NextResponse.json({ topic: updatedTopic })
  } catch (error) {
    console.error('Update topic error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to update topic' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  try {
    const session = await requireAuth()
    const { topicId } = await params

    // Verify topic ownership through project
    const topic = await ownedTopic(session.user.id, topicId)

    if (!topic) {
      return NextResponse.json(
        { error: 'Topic not found' },
        { status: 404 }
      )
    }

    // Delete topic (cascade will handle related records), and stop listing it as a prerequisite.
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE topics SET prerequisite_ids = array_remove(prerequisite_ids, ${topicId}) WHERE project_id = ${topic.projectId} AND ${topicId} = ANY(prerequisite_ids)`,
      prisma.topic.delete({ where: { id: topicId } }),
    ])

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete topic error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to delete topic' },
      { status: 500 }
    )
  }
}
