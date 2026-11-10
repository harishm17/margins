/**
 * Where a chat answer is stored once the AI service has finished it (see lib/chat/stream): the
 * assistant message, or the removal of a failed question. What the answer cost is on the usage ledger
 * already: the AI service writes it, call by call, as it makes the calls (it bills the account itself).
 *
 * The client is passed in (not imported) so the e2e specs can run this against the stack's
 * database; imports stay relative for the same reason.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { toStoredCitations } from '../lib/chat/citations'
import type { ChatStorage } from '../lib/chat/stream'

export type ChatStorageContext = {
  userId: string
  threadId: string
  /** The question this answer is for. */
  userMessageId: string
  /** The question started the conversation (so a failure removes the conversation too). */
  isNewThread: boolean
}

export function createChatStorage(db: PrismaClient, context: ChatStorageContext): ChatStorage {
  const { userId, threadId, userMessageId, isNewThread } = context

  return {
    async saveAnswer(record) {
      return db.$transaction(async (tx) => {
        // The thread is the student's: a write to anyone else's matches no row, and the answer is not stored.
        const mine = await tx.chatThread.count({ where: { id: threadId, userId } })
        if (mine === 0) throw new Error('Thread not found')
        const message = await tx.chatMessage.create({
          data: {
            threadId,
            role: 'assistant',
            content: record.text,
            citations: toStoredCitations(record.sources, record.marks) as unknown as Prisma.InputJsonValue,
            ...(record.tutor != null ? { tutor: record.tutor as Prisma.InputJsonValue } : {}),
            llmInputTokens: record.usage.inputTokens,
            llmOutputTokens: record.usage.outputTokens,
            llmCostUsd: record.usage.costUsd.toFixed(6),
          },
          select: { id: true },
        })
        await tx.chatThread.updateMany({ where: { id: threadId, userId }, data: { updatedAt: new Date() } })
        return message.id
      })
    },
    async recordFailure() {
      // A failure is never kept in the conversation: the question goes (and a new thread that
      // never got an answer goes with it), and the browser shows the failure with a retry.
      await db.$transaction(async (tx) => {
        await tx.chatMessage.deleteMany({ where: { id: userMessageId, thread: { userId } } })
        if (isNewThread) {
          const removed = await tx.chatThread.deleteMany({ where: { id: threadId, userId, messages: { none: {} } } })
          // The state a map link seeded for the conversation goes with it.
          if (removed.count > 0) await tx.tutorState.deleteMany({ where: { userId, scope: 'ask', scopeKey: threadId } })
        }
      })
      return { discarded: true }
    },
  }
}
