import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { createChatStorage } from './chat-storage'
import type { UsageInfo } from '../lib/chat/stream'

/** A stand-in database with no usage ledger at all: touching `llmUsageEvent` would throw. */
function database() {
  const messages: Record<string, unknown>[] = []
  const tx = {
    chatMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        messages.push(data)
        return { id: 'answer-1' }
      },
      deleteMany: async () => ({ count: 1 }),
    },
    chatThread: { update: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    tutorState: { deleteMany: async () => ({ count: 0 }) },
  }
  const db = { ...tx, $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) }
  return { db: db as unknown as PrismaClient, messages }
}

const context = { userId: 'u1', threadId: 't1', userMessageId: 'question-1', isNewThread: false }
const usage: UsageInfo = { model: 'claude-opus-5-5', inputTokens: 9000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 500, costUsd: 0.01 }

describe('chat storage', () => {
  // The AI service bills the account for the answer as it makes the calls (billing.py). A second row written here
  // would count the answer twice, and one written only when the save works would miss a browser that dropped.
  it('keeps what an answer cost on the message and writes nothing to the usage ledger', async () => {
    const { db, messages } = database()
    await createChatStorage(db, context).saveAnswer({ text: 'Answer.', sources: [], marks: [], usage })
    assert.equal(messages[0].llmInputTokens, 9000)
    assert.equal(messages[0].llmCostUsd, '0.010000')
  })

  it('removes a failed question without a ledger row too', async () => {
    const { db } = database()
    assert.deepEqual(await createChatStorage(db, context).recordFailure('LLM_REFUSED', usage), { discarded: true })
  })
})
