/**
 * The student's margin notes on a topic's reading (spec §5.2). Notes are private to the student.
 * GET    /api/topics/[topicId]/margin-notes - their notes and explained passages, oldest first.
 * POST   /api/topics/[topicId]/margin-notes { chunkId, text } - writes a note in a passage's margin.
 * DELETE /api/topics/[topicId]/margin-notes?id= - removes one of their notes.
 */

import { ownedTopic } from '@/server/owned'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { loadMarginNotes, toNoteView } from '@/lib/reader/load-reader'
import {
  apiError,
  ApiErrorCode,
  apiInternal,
  apiInvalidInput,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
  zodDetails,
} from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const MAX_NOTE = 4000
const MAX_NOTES_PER_TOPIC = 500

const createSchema = z.object({ chunkId: z.string().min(1).max(100), text: z.string().trim().min(1).max(MAX_NOTE) })

const noteLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 })


export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    if (!(await ownedTopic(auth.user.id, topicId))) return apiNotFound('Topic not found')
    return NextResponse.json({ notes: await loadMarginNotes(auth.user.id, topicId) })
  } catch (error) {
    console.error('Margin notes error:', error)
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
    const parsed = createSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return apiInvalidInput('Invalid input', zodDetails(parsed.error))
    const rate = noteLimiter.check(auth.user.id)
    if (!rate.ok) {
      return NextResponse.json({ error: 'Too many notes. Please wait a moment and try again.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } })
    }

    // A note belongs to a passage of this course's files; the chunk id is not a foreign key, so it is checked here.
    const chunk = await prisma.materialChunk.findFirst({ where: { id: parsed.data.chunkId, material: { projectId: topic.projectId } }, select: { materialId: true } })
    if (!chunk) return apiNotFound('Passage not found')
    if ((await prisma.marginNote.count({ where: { userId: auth.user.id, topicId } })) >= MAX_NOTES_PER_TOPIC) {
      return apiError(ApiErrorCode.CONFLICT, 'This topic has as many notes as it can hold. Delete one to add another.', { code: 'TOO_MANY_NOTES' }, 409)
    }
    const note = await prisma.marginNote.create({
      data: { userId: auth.user.id, topicId, materialId: chunk.materialId, chunkId: parsed.data.chunkId, kind: 'note', text: parsed.data.text },
      select: { id: true, chunkId: true, kind: true, text: true, reply: true, createdAt: true },
    })
    return NextResponse.json({ note: toNoteView(note) }, { status: 201 })
  } catch (error) {
    console.error('Margin note create error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to save the note')
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const auth = await requireAuth()
    const { topicId } = await params
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return apiInvalidInput('id is required')
    // Own notes only: the owner is part of the match.
    const removed = await prisma.marginNote.deleteMany({ where: { id, topicId, userId: auth.user.id } })
    if (removed.count === 0) return apiNotFound('Note not found')
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Margin note delete error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to delete the note')
  }
}
