/**
 * The student's margin notes on a topic's reading (spec §5.2). Notes are private to the student.
 * GET    /api/topics/[topicId]/margin-notes - their notes and explained passages, oldest first.
 * POST   /api/topics/[topicId]/margin-notes { chunkId, text } - writes a note in a passage's margin.
 * DELETE /api/topics/[topicId]/margin-notes?id= - removes one of their notes.
 */

import { logServerError } from '@/lib/ops/log'
import { assertQuota, quotaErrorResponse } from '@/lib/api/quota'
import { readJson } from '@/lib/api/read-json'
import { ownedTopic } from '@/server/owned'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter, enforceMutationLimit } from '@/lib/api/rate-limit'
import { loadMarginNotes, toNoteView } from '@/lib/reader/load-reader'
import {
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const MAX_NOTE = 4000

const createSchema = z.object({ chunkId: z.string().min(1).max(100), text: z.string().trim().min(1).max(MAX_NOTE) })

const noteLimiter = createRateLimiter({ name: 'margin-notes', limit: 60, windowMs: 60_000 })


export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    if (!(await ownedTopic(auth.user.id, topicId))) return apiNotFound('Topic not found')
    return NextResponse.json({ notes: await loadMarginNotes(auth.user.id, topicId) })
  } catch (error) {
    logServerError('Margin notes error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load your notes')
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const topic = await ownedTopic(auth.user.id, topicId)
    if (!topic) return apiNotFound('Topic not found')
    const parsed = await readJson(request, createSchema)
    if (!parsed.ok) return parsed.response
    const rate = await noteLimiter.check(auth.user.id)
    if (!rate.ok) {
      return NextResponse.json({ error: 'Too many notes. Please wait a moment and try again.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } })
    }

    // A note belongs to a passage of this course's files; the chunk id is not a foreign key, so it is checked here.
    const chunk = await prisma.materialChunk.findFirst({ where: { id: parsed.data.chunkId, material: { projectId: topic.projectId } }, select: { materialId: true, chunkText: true } })
    if (!chunk) return apiNotFound('Passage not found')
    const note = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, auth.user, 'notes', { topicId })
      return tx.marginNote.create({
        data: {
          userId: auth.user.id,
          projectId: topic.projectId,
          topicId,
          materialId: chunk.materialId,
          chunkId: parsed.data.chunkId,
          quote: chunk.chunkText,
          kind: 'note',
          text: parsed.data.text,
        },
        select: { id: true, chunkId: true, kind: true, text: true, reply: true, createdAt: true },
      })
    })
    return NextResponse.json({ note: toNoteView(note) }, { status: 201 })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    logServerError('Margin note create error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save the note')
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const limited = await enforceMutationLimit(auth.user.id)
    if (limited) return limited
    const { topicId } = await params
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return apiInvalidInput('id is required')
    // Own notes only: the owner is part of the match.
    const removed = await prisma.marginNote.deleteMany({ where: { id, topicId, userId: auth.user.id } })
    if (removed.count === 0) return apiNotFound('Note not found')
    return NextResponse.json({ ok: true })
  } catch (error) {
    logServerError('Margin note delete error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to delete the note')
  }
}
