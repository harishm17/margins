import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { Prisma } from '@prisma/client'

const metricEntrySchema = z.object({
  ttftMs: z.number().finite().nonnegative().max(60000).optional(),
  ttfaMs: z.number().finite().nonnegative().max(60000).optional(),
  speechMs: z.number().finite().nonnegative().max(600000).optional(),
  responseMs: z.number().finite().nonnegative().max(600000).optional(),
  toolLatencyMs: z.number().finite().nonnegative().max(600000).optional(),
  toolFailures: z.number().int().nonnegative().max(100).optional(),
  interrupts: z.number().int().nonnegative().max(50).optional(),
  lastDetectedLanguage: z.string().max(8).regex(/^[a-z]{2,8}$/i).optional(),
}).strict()

const metricsSchema = z.object({
  sessionId: id(),
  entry: metricEntrySchema,
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const parsed = await readJson(request, metricsSchema)
    if (!parsed.ok) return parsed.response
    const payload = parsed.data

    const session = await prisma.voiceDrillSession.findFirst({
      where: {
        id: payload.sessionId,
        userId: auth.user.id,
      },
    })

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const existing = session.metrics as { entries?: Prisma.JsonObject[]; total?: number } | null
    const nextEntries = [...(existing?.entries || []), payload.entry].slice(-200)
    const totalCount = (existing?.total || existing?.entries?.length || 0) + 1

    await prisma.voiceDrillSession.update({
      where: { id: payload.sessionId },
      data: {
        metrics: {
          entries: nextEntries,
          last: payload.entry,
          total: totalCount,
        },
        ...(payload.entry.lastDetectedLanguage
          ? { lastDetectedLanguage: payload.entry.lastDetectedLanguage }
          : {}),
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Voice metrics error:', error)

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
    }

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json({ error: 'Failed to store metrics' }, { status: 500 })
  }
}
