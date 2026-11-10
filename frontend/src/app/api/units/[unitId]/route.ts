/**
 * PATCH /api/units/[unitId] - rename a unit, change its summary or week label, or move it
 *   Body: { title?, summary?: string | null, weekLabel?: string | null, orderIndex?: int >= 0 }
 *   orderIndex is the position among the units. Moving a unit moves its topics with it: the
 *   course order of the topics is renormalised in the same transaction.
 *   200: { unit: { id, title, summary, weekLabel, orderIndex } }
 *
 * DELETE /api/units/[unitId] - delete an empty unit
 *   409 CONFLICT while it still holds topics (move or delete them first).
 *   200: { success: true }
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { moveInOrder } from '@/lib/topics/ordering'
import { ownedUnit } from '@/server/owned'
import { compactUnitOrder, normalizeTopicOrder } from '@/lib/topics/normalize-order'

const updateUnitSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(600).nullable().optional(),
  weekLabel: z.string().trim().max(80).nullable().optional(),
  orderIndex: z.number().int().min(0).optional(),
})

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ unitId: string }> }) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { unitId } = await params
    const unit = await ownedUnit(session.user.id, unitId)
    if (!unit) return apiNotFound('Unit not found')

    const parsed = await readJson(request, updateUnitSchema)
    if (!parsed.ok) return parsed.response
    const { orderIndex, summary, weekLabel, title } = parsed.data

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.unit.update({
        where: { id: unitId },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary: summary || null } : {}),
          ...(weekLabel !== undefined ? { weekLabel: weekLabel || null } : {}),
        },
      })
      if (orderIndex !== undefined) {
        const units = await tx.unit.findMany({
          where: { projectId: unit.projectId },
          orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
        const order = moveInOrder(units.map((item) => item.id), unitId, orderIndex)
        for (const [index, id] of order.entries()) await tx.unit.update({ where: { id }, data: { orderIndex: index } })
        await compactUnitOrder(tx, unit)
        await normalizeTopicOrder(tx, unit)
        return tx.unit.findUniqueOrThrow({ where: { id: unitId } })
      }
      return row
    })

    return NextResponse.json({
      unit: { id: updated.id, title: updated.title, summary: updated.summary, weekLabel: updated.weekLabel, orderIndex: updated.orderIndex },
    })
  } catch (error) {
    logServerError('Update unit error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof SyntaxError) return apiError(ApiErrorCode.INVALID_INPUT, 'Invalid JSON body', undefined, 400)
    return apiInternal('Failed to update unit')
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ unitId: string }> }) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { unitId } = await params
    const unit = await ownedUnit(session.user.id, unitId)
    if (!unit) return apiNotFound('Unit not found')

    const topicCount = await prisma.topic.count({ where: { unitId } })
    if (topicCount > 0) {
      return apiError(ApiErrorCode.CONFLICT, 'Move or delete the topics in this unit first', undefined, 409)
    }
    await prisma.$transaction(async (tx) => {
      await tx.unit.delete({ where: { id: unitId } })
      await compactUnitOrder(tx, unit)
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    logServerError('Delete unit error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to delete unit')
  }
}
