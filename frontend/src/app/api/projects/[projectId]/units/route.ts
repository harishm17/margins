/**
 * POST /api/projects/[projectId]/units - add a unit (a week, a chapter, a lecture group)
 *
 * Body: { title: string(1..200), summary?: string(..600) | null, weekLabel?: string(..80) | null,
 *         orderIndex?: int >= 0 }   (orderIndex is the position among the units; default: last)
 * 200: { unit: { id, title, summary, weekLabel, orderIndex } }
 *
 * Units are read through server queries (course shell, topics data); there is no list route.
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { assertQuota, quota, quotaErrorResponse, quotaResponse } from '@/lib/api/quota'
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
import { compactUnitOrder, normalizeTopicOrder } from '@/lib/topics/normalize-order'

const createUnitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(600).nullable().optional(),
  weekLabel: z.string().trim().max(80).nullable().optional(),
  orderIndex: z.number().int().min(0).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { projectId } = await params

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true } })
    if (!project) return apiNotFound('Project not found')

    const parsed = await readJson(request, createUnitSchema)
    if (!parsed.ok) return parsed.response
    const { title, summary, weekLabel, orderIndex } = parsed.data

    const unit = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, session.user, 'units', { projectId })
      const last = await tx.unit.findFirst({ where: { projectId }, orderBy: { orderIndex: 'desc' }, select: { orderIndex: true } })
      const created = await tx.unit.create({
        data: { projectId, title, summary: summary || null, weekLabel: weekLabel || null, orderIndex: (last?.orderIndex ?? -1) + 1 },
      })
      if (orderIndex !== undefined) {
        const units = await tx.unit.findMany({ where: { projectId }, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }], select: { id: true } })
        const order = moveInOrder(units.map((item) => item.id), created.id, orderIndex)
        for (const [index, id] of order.entries()) await tx.unit.update({ where: { id }, data: { orderIndex: index } })
      }
      await compactUnitOrder(tx, projectId)
      await normalizeTopicOrder(tx, projectId)
      return tx.unit.findUniqueOrThrow({ where: { id: created.id } })
    })

    return NextResponse.json({
      unit: { id: unit.id, title: unit.title, summary: unit.summary, weekLabel: unit.weekLabel, orderIndex: unit.orderIndex },
    })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    logServerError('Create unit error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    if (error instanceof SyntaxError) return apiError(ApiErrorCode.INVALID_INPUT, 'Invalid JSON body', undefined, 400)
    return apiInternal('Failed to create unit')
  }
}
