import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { createChatStorage } from './chat-storage'
import type { UsageInfo } from '../lib/chat/stream'

/** A stand-in for the database that keeps the ledger rows it is given; everything else answers as Prisma would. */
function recordingDb() {
  const ledger: Record<string, unknown>[] = []
  const tx = {
    chatMessage: { create: async () => ({ id: 'answer-1' }), deleteMany: async () => ({ count: 1 }) },
    chatThread: { update: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    tutorState: { deleteMany: async () => ({ count: 0 }) },
    llmUsageEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        ledger.push(data)
        return data
      },
    },
  }
  const db = { ...tx, $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) }
  return { db: db as unknown as PrismaClient, ledger }
}

const context = { userId: 'u1', projectId: 'p1', threadId: 't1', userMessageId: 'question-1', isNewThread: false }
const usage: UsageInfo = { model: 'claude-opus-5-5', inputTokens: 9000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 500, costUsd: 0.01 }
const figures = (row: Record<string, unknown>) => [row.source, row.sourceId, row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens]

describe('the chat ledger row', () => {
  it("keeps an answer's cache reads and writes apart from the input they are part of (A4)", async () => {
    const { db, ledger } = recordingDb()
    await createChatStorage(db, context).saveAnswer({ text: 'Answer.', sources: [], marks: [], usage })
    assert.deepEqual(ledger.map(figures), [['chat', 'answer-1', 9000, 8000, 500]])
  })

  it('keeps them for a failed answer too', async () => {
    const { db, ledger } = recordingDb()
    await createChatStorage(db, context).recordFailure('LLM_REFUSED', usage)
    assert.deepEqual(ledger.map(figures), [['chat', 'question-1', 9000, 8000, 500]])
  })
})
