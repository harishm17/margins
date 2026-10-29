/**
 * POST /api/projects/[projectId]/chat: ask a question about the project's materials.
 *
 * Body: { question, threadId?, topicId? }. Answers with a stream of newline-delimited JSON
 * events (see src/lib/chat/events.ts): `thread`, `user_message`, then the AI service's own
 * events, then `saved`. Errors before the stream starts are ordinary JSON errors.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { ApiErrorCode, apiError, apiInvalidInput, apiNotFound, apiUnauthorized, zodDetails } from '@/lib/api/errors'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { chatErrorMessage } from '@/lib/chat/errors'
import {
  MAX_QUESTION_CHARS,
  errorCodeFromResponse,
  requestChatAnswer,
  titleFromQuestion,
  toHistoryTurns,
} from '@/lib/chat/server'
import { relayChatStream } from '@/lib/chat/stream'
import { createChatStorage } from '@/server/chat-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Every question is a model call.
const chatLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 })

const bodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, 'Ask a question')
    .max(MAX_QUESTION_CHARS, `Keep the question under ${MAX_QUESTION_CHARS} characters`),
  threadId: z.string().uuid().optional(),
  topicId: z.string().uuid().optional(),
})

function chatFailure(code: string) {
  const info = chatErrorMessage(code)
  return apiError(
    code === 'LLM_DAILY_BUDGET' ? ApiErrorCode.RATE_LIMITED : ApiErrorCode.UPSTREAM_ERROR,
    info.message,
    { code, retryable: info.retryable },
    info.status
  )
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  if (!userId) return apiUnauthorized()

  const limit = chatLimiter.check(userId)
  if (!limit.ok) {
    const response = apiError(
      ApiErrorCode.RATE_LIMITED,
      chatErrorMessage('RATE_LIMITED').message,
      { code: 'RATE_LIMITED', retryable: true },
      429
    )
    response.headers.set('Retry-After', String(limit.retryAfterSeconds))
    return response
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiInvalidInput('The request body must be JSON')
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return apiInvalidInput(parsed.error.issues[0]?.message ?? 'Invalid input', zodDetails(parsed.error))
  }
  const { question, threadId, topicId } = parsed.data

  const { projectId } = await params
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  })
  if (!project) return apiNotFound('Project not found')

  if (topicId) {
    const topic = await prisma.topic.findFirst({ where: { id: topicId, projectId }, select: { id: true } })
    if (!topic) return apiNotFound('Topic not found')
  }

  // An existing thread must be this user's, in this project.
  let thread = threadId
    ? await prisma.chatThread.findFirst({
        where: { id: threadId, projectId, userId },
        select: { id: true, title: true },
      })
    : null
  if (threadId && !thread) return apiNotFound('Conversation not found')

  const isNewThread = !thread
  const history = thread
    ? toHistoryTurns(
        (
          await prisma.chatMessage.findMany({
            where: { threadId: thread.id },
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: { role: true, content: true },
          })
        ).reverse()
      )
    : []

  // Ask first. When the AI service refuses (daily budget) or is down, nothing is stored, so
  // a refused question leaves no trace. Once it accepts, the question is stored and the
  // answer streams.
  let upstream: Response
  try {
    upstream = await requestChatAnswer({ projectId, userId, question, history, topicId })
  } catch (error) {
    console.error('[CHAT] The AI service is not reachable:', error)
    return chatFailure('CHAT_UNAVAILABLE')
  }
  if (!upstream.ok || !upstream.body) {
    const code = await errorCodeFromResponse(upstream)
    console.error(`[CHAT] The AI service answered ${upstream.status} (${code})`)
    return chatFailure(code)
  }

  let userMessageId: string
  try {
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { userId, projectId, title: titleFromQuestion(question) },
        select: { id: true, title: true },
      })
    }
    const userMessage = await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'user', content: question },
      select: { id: true },
    })
    userMessageId = userMessage.id
  } catch (error) {
    console.error('[CHAT] Could not store the question:', error)
    await upstream.body.cancel().catch(() => {})
    return apiError(ApiErrorCode.INTERNAL_ERROR, 'Could not save your question. Try again.', undefined, 500)
  }
  const activeThread = thread
  const storage = createChatStorage(prisma, {
    userId,
    projectId,
    threadId: activeThread.id,
    userMessageId,
    isNewThread,
  })

  const stream = relayChatStream({
    head: [
      { type: 'thread', threadId: activeThread.id, title: activeThread.title, isNew: isNewThread },
      { type: 'user_message', id: userMessageId },
    ],
    upstream: upstream.body,
    storage,
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
