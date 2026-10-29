/**
 * Where a chat answer is stored once the AI service has finished it (see lib/chat/stream): the
 * assistant message, or the removal of a failed question, plus the spend on the usage ledger.
 *
 * The client is passed in (not imported) so the e2e specs can run this against the stack's
 * database; imports stay relative for the same reason.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { toStoredCitations } from '../lib/chat/citations'
import type { ChatStorage, UsageInfo } from '../lib/chat/stream'

export type ChatStorageContext = {
  userId: string
  projectId: string
  threadId: string
  /** The question this answer is for. */
  userMessageId: string
  /** The question started the conversation (so a failure removes the conversation too). */
  isNewThread: boolean
  log?: (message: string, error?: unknown) => void
}

const billable = (usage: UsageInfo | null | undefined): usage is UsageInfo =>
  !!usage && (usage.costUsd > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)

export function createChatStorage(db: PrismaClient, context: ChatStorageContext): ChatStorage {
  const { userId, projectId, threadId, userMessageId, isNewThread } = context
  const log = context.log ?? ((message: string, error?: unknown) => console.error(`[CHAT] ${message}`, error))

  // The ledger row is written in the same transaction as the message it pays for. The daily
  // budget sums the ledger, not the messages, so deleting a thread cannot lower it.
  const ledgerRow = (usage: UsageInfo, sourceId: string) => ({
    userId,
    projectId,
    source: 'chat',
    sourceId,
    models: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd.toFixed(6),
    createdAt: new Date(),
  })

  /**
   * The transaction that stores a billed answer (or removes a failed question) can fail: the
   * account and its conversation were deleted while the answer streamed, or the database refused
   * it for another reason. The model was paid either way, so the cost goes on the ledger on its
   * own. If the account is gone, the ledger's trigger keeps the row with its ids cleared (the same
   * rule the AI service's jobs and voice turns get), so it still counts toward the global cap.
   */
  async function keepingTheSpend<T>(usage: UsageInfo | null, sourceId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (billable(usage)) {
        try {
          await db.llmUsageEvent.create({ data: ledgerRow(usage, sourceId) })
        } catch (ledgerError) {
          log(`Could not record chat usage ($${usage.costUsd.toFixed(6)}) after a failed save:`, ledgerError)
        }
      }
      throw error
    }
  }

  return {
    async saveAnswer(record) {
      return keepingTheSpend(record.usage, userMessageId, () => db.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
          data: {
            threadId,
            role: 'assistant',
            content: record.text,
            citations: toStoredCitations(record.sources, record.marks) as unknown as Prisma.InputJsonValue,
            llmInputTokens: record.usage.inputTokens,
            llmOutputTokens: record.usage.outputTokens,
            llmCostUsd: record.usage.costUsd.toFixed(6),
          },
          select: { id: true },
        })
        if (billable(record.usage)) {
          await tx.llmUsageEvent.create({ data: ledgerRow(record.usage, message.id) })
        }
        await tx.chatThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } })
        return message.id
      }))
    },
    async recordFailure(_code, usage) {
      // A failure is never kept in the conversation: the question goes (and a new thread that
      // never got an answer goes with it), and the browser shows the failure with a retry. A
      // billed call still gets its ledger row, so the cost counts toward the daily budget; the
      // row's source id is a plain column, so it outlives the question it names.
      await keepingTheSpend(usage, userMessageId, () => db.$transaction(async (tx) => {
        if (billable(usage)) {
          await tx.llmUsageEvent.create({ data: ledgerRow(usage, userMessageId) })
        }
        await tx.chatMessage.deleteMany({ where: { id: userMessageId } })
        if (isNewThread) {
          await tx.chatThread.deleteMany({ where: { id: threadId, messages: { none: {} } } })
        }
      }))
      return { discarded: true }
    },
  }
}
