/**
 * POST /api/me/reader-note - The student closed the "About this reading" row above the reader (the Focus and PDF notes).
 * Stored on the user, like the one-time effort card, so it stays closed on every device. Closing it twice changes nothing.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'

export async function POST() {
  try {
    const session = await requireAuth()
    await prisma.user.updateMany({
      where: { id: session.user.id, seenReaderNoteAt: null },
      data: { seenReaderNoteAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Reader note error:', error)
    return NextResponse.json({ error: 'Failed to save that' }, { status: 500 })
  }
}
