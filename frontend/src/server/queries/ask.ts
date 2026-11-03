import { areRecordIds } from '@/lib/ids'
import { prisma } from '@/lib/db/prisma'
import { parseStoredCitations } from '@/lib/chat/citations'
import { toChatMessages, type ChatMessage } from '@/features/ask/chat-messages'
import { parseStoredTutor, turnView } from '@/lib/ask/tutor-message'
import { getTutorState } from '@/lib/tutor/store'

/** Everything here is filtered by the user id; an id that is not theirs is simply not found. */

const MAX_THREADS = 100

export type AskThread = { id: string; title: string | null; updatedAt: string }

/** The user's conversations in a course, most recently active first. */
export async function listAskThreads(userId: string, courseId: string): Promise<AskThread[]> {
  if (!areRecordIds(courseId)) return []
  const threads = await prisma.chatThread.findMany({
    where: { projectId: courseId, userId },
    orderBy: { updatedAt: 'desc' },
    take: MAX_THREADS,
    select: { id: true, title: true, updatedAt: true },
  })
  return threads.map((thread) => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt.toISOString() }))
}

/** One conversation with its messages, or null when it is not the user's or not in this course. */
export async function getAskThread(
  userId: string,
  courseId: string,
  threadId: string
): Promise<{ id: string; messages: ChatMessage[]; workedAllowed: boolean } | null> {
  if (!areRecordIds(courseId, threadId)) return null
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, projectId: courseId, userId },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, citations: true, tutor: true },
      },
    },
  })
  if (!thread) return null
  const state = await getTutorState(userId, 'ask', thread.id)
  return {
    id: thread.id,
    workedAllowed: state.attempts >= 1,
    messages: toChatMessages(
      thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.role === 'assistant' ? parseStoredCitations(message.citations) : null,
        turn: message.role === 'assistant' ? turnView(parseStoredTutor(message.tutor)) : null,
      }))
    ),
  }
}

/** How many of the course's files are ready to be searched. */
export async function countSearchableMaterials(userId: string, courseId: string): Promise<number> {
  if (!areRecordIds(courseId)) return 0
  return prisma.material.count({
    where: { projectId: courseId, validationStatus: 'valid', project: { userId } },
  })
}

/** The server's clock, passed to the page so the thread groups match between server and browser. */
export const serverNow = (): number => Date.now()
