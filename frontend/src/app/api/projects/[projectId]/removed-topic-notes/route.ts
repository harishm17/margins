/**
 * The student's margin notes whose topic was deleted (finding 78). The note stays, with its course and quote, and is
 * listed under "Notes from removed topics" on the course's topics page.
 * DELETE /api/projects/[projectId]/removed-topic-notes?id= - removes one of their own notes of this course whose topic is gone.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { apiInternal, apiInvalidInput, apiNotFound, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { projectId } = await params
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return apiInvalidInput('id is required')
    // Own notes only, of this course, and only ones whose topic is gone: a note still on a topic is deleted from its topic.
    const removed = await prisma.marginNote.deleteMany({ where: { id, projectId, topicId: null, userId: auth.user.id } })
    if (removed.count === 0) return apiNotFound('Note not found')
    return NextResponse.json({ ok: true })
  } catch (error) {
    logServerError('Removed-topic note delete error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to delete the note')
  }
}
