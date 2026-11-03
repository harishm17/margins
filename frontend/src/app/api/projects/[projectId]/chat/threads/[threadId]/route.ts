import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { apiNotFound, apiUnauthorized } from '@/lib/api/errors'
import { parseStoredCitations } from '@/lib/chat/citations'
import { parseStoredTutor, turnView } from '@/lib/ask/tutor-message'
import { getTutorState } from '@/lib/tutor/store'

export const dynamic = 'force-dynamic'

async function ownedThread(projectId: string, threadId: string) {
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  if (!userId) return { userId: null, thread: null }
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, projectId, userId },
    select: { id: true, title: true },
  })
  return { userId, thread }
}

/** GET: the messages of one conversation, oldest first. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> }
) {
  const { projectId, threadId } = await params
  const { userId, thread } = await ownedThread(projectId, threadId)
  if (!userId) return apiUnauthorized()
  if (!thread) return apiNotFound('Conversation not found')

  const messages = await prisma.chatMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, citations: true, tutor: true, createdAt: true },
  })
  const state = await getTutorState(userId, 'ask', threadId)
  return NextResponse.json({
    thread: { id: thread.id, title: thread.title, workedAllowed: state.attempts >= 1 },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      citations: m.role === 'assistant' ? parseStoredCitations(m.citations) : null,
      // What the reply tutored. The check card's answer stays on the server (GET /api/ask-checks).
      turn: m.role === 'assistant' ? turnView(parseStoredTutor(m.tutor)) : null,
      createdAt: m.createdAt.toISOString(),
    })),
  })
}

/** DELETE: remove a conversation and its messages. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> }
) {
  const { projectId, threadId } = await params
  const { userId, thread } = await ownedThread(projectId, threadId)
  if (!userId) return apiUnauthorized()
  if (!thread) return apiNotFound('Conversation not found')

  await prisma.chatThread.delete({ where: { id: threadId } })
  return NextResponse.json({ success: true })
}
