/**
 * POST /api/me/effort-intro - The student closed the one-time card that explains trying before help
 * (spec §5). Stored on the user, so it stays closed on every device. Closing it twice changes nothing.
 */

import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'

export async function POST() {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    await prisma.user.updateMany({
      where: { id: session.user.id, seenEffortIntroAt: null },
      data: { seenEffortIntroAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Effort intro error:', error)
    return NextResponse.json({ error: 'Failed to save that' }, { status: 500 })
  }
}
