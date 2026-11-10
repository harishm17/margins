import { readSession } from '@/lib/auth/get-session'
/**
 * POST /api/projects/[projectId]/chat: ask a question about the project's materials.
 *
 * Body: { question, threadId?, topicId?, conceptId?, event?: 'show_worked' }. A new conversation started with
 * `conceptId` (the knowledge map's "Ask about this") has that concept as a routed concept from its first turn.
 * Answers with a stream of
 * newline-delimited JSON events (see src/lib/chat/events.ts): `thread`, `user_message`, then the
 * AI service's own events (the route of the question first), then `saved` and `tutor`. Errors
 * before the stream starts are ordinary JSON errors.
 *
 * Attempt-first (spec 6.3): a question that is a question of the student's mock exam in progress is
 * declined without a model call. Otherwise the thread's tutor state goes to the AI service with the
 * question, and once the reply is stored the state moves and a reply that taught records level 3.
 */
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { ApiErrorCode, apiError, apiInvalidInput, apiNotFound, apiUnauthorized, zodDetails } from '@/lib/api/errors'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { EXAM_GUARD_NOTE, EXAM_GUARD_TITLE, declinedStream, examTakeHref, guardingExam } from '@/lib/ask/exam-guard-server'
import { finishAskTurn, loadAskState, loadUnderstand, planAskTurn, type AskPlan } from '@/lib/ask/ask-turn'
import { WORKED_EXAMPLE_REQUEST, browserCard, parseCard, parseRoute, toStoredTutor, type AskRoute } from '@/lib/ask/tutor-message'
import { studentTimeZone } from '@/lib/learning/student-time-zone'
import { seedTutorConcepts } from '@/lib/tutor/store'
import { chatErrorMessage } from '@/lib/chat/errors'
import {
  MAX_QUESTION_CHARS,
  errorCodeFromResponse,
  requestChatAnswer,
  titleFromQuestion,
  toHistoryTurns,
} from '@/lib/chat/server'
import { relayChatStream, type RelayHooks } from '@/lib/chat/stream'
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
  // The concept a new conversation is about; ignored once the conversation exists.
  conceptId: z.string().uuid().optional(),
  // "Show me a worked example" (spec 6.2): the student's button, allowed after one genuine attempt.
  event: z.enum(['show_worked']).optional(),
  // The browser's id for this send. The same id again (a double Enter, a retry after a dropped connection, a reload while the
  // request was in flight) is answered with the conversation that already holds the question instead of storing it twice.
  clientRequestId: z.string().uuid().optional(),
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

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await readSession()
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
  const { threadId, topicId, conceptId, clientRequestId } = parsed.data
  const showWorked = parsed.data.event === 'show_worked'
  const question = showWorked ? WORKED_EXAMPLE_REQUEST : parsed.data.question

  const { projectId } = await params
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  })
  if (!project) return apiNotFound('Project not found')

  // A send the server already took: say where it went. Nothing is asked of the model or stored a second time.
  if (clientRequestId) {
    const taken = await prisma.chatMessage.findFirst({
      where: { clientRequestId, thread: { projectId, userId } },
      select: { threadId: true },
    })
    if (taken) return NextResponse.json({ duplicate: true, threadId: taken.threadId })
  }

  if (topicId) {
    const topic = await prisma.topic.findFirst({ where: { id: topicId, projectId }, select: { id: true } })
    if (!topic) return apiNotFound('Topic not found')
  }
  // Only a new conversation takes its first concept from the student's choice; the course's own active concepts only.
  const seedConceptId = !threadId && conceptId ? conceptId : null
  if (seedConceptId) {
    const concept = await prisma.concept.findFirst({ where: { id: seedConceptId, projectId, status: 'active' }, select: { id: true } })
    if (!concept) return apiNotFound('Concept not found')
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
  // The exam in progress comes first: a pasted exam question is declined before anything else is spent on it. The
  // student's last messages are read with this one (a question asked in pieces), and what the words do not catch,
  // the AI service's meaning check does (a rewording, a translation).
  const guarded = showWorked ? undefined : await guardingExam(userId, projectId, question, history)
  const declined = !!guarded
  const planned = planAskTurn(
    await loadAskState(userId, thread?.id ?? null),
    question,
    showWorked ? 'show_worked' : 'ask',
    history.filter((turn) => turn.role === 'user' && turn.content !== EXAM_GUARD_NOTE).map((turn) => turn.content),
    await loadUnderstand(userId, thread?.id ?? null)
  )
  if (!planned.ok) {
    return apiError(ApiErrorCode.CONFLICT, 'Have a go at it first, and then I can show you a worked example.', { code: 'WORKED_NOT_ALLOWED' }, 409)
  }
  const plan = planned.plan

  // Ask first. When the AI service refuses (daily budget) or is down, nothing is stored, so
  // a refused question leaves no trace. Once it accepts, the question is stored and the
  // answer streams.
  let upstream: ReadableStream<Uint8Array>
  if (declined) {
    upstream = declinedStream(guarded ? examTakeHref(projectId, guarded.examId) : null)
  } else {
    let response: Response
    try {
      response = await requestChatAnswer({ projectId, userId, threadId: thread?.id, question, history, topicId, tutor: plan.tutor })
    } catch (error) {
      console.error('[CHAT] The AI service is not reachable:', error)
      return chatFailure('CHAT_UNAVAILABLE')
    }
    if (!response.ok || !response.body) {
      const code = await errorCodeFromResponse(response)
      console.error(`[CHAT] The AI service answered ${response.status} (${code})`)
      return chatFailure(code)
    }
    upstream = response.body
  }

  let userMessageId: string
  try {
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { userId, projectId, title: declined ? EXAM_GUARD_TITLE : titleFromQuestion(question) },
        select: { id: true, title: true },
      })
    }
    const userMessage = await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'user', content: declined ? EXAM_GUARD_NOTE : question, clientRequestId: clientRequestId ?? null },
      select: { id: true },
    })
    userMessageId = userMessage.id
  } catch (error) {
    // The same send arrived twice at once and the other one stored it first: no second question, and no empty conversation left behind.
    if (clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await upstream.cancel().catch(() => {})
      const taken = await prisma.chatMessage.findFirst({ where: { clientRequestId }, select: { threadId: true } })
      if (isNewThread && thread && thread.id !== taken?.threadId) await prisma.chatThread.delete({ where: { id: thread.id } }).catch(() => {})
      return NextResponse.json({ duplicate: true, threadId: taken?.threadId ?? null })
    }
    console.error('[CHAT] Could not store the question:', error)
    await upstream.cancel().catch(() => {})
    return apiError(ApiErrorCode.INTERNAL_ERROR, 'Could not save your question. Try again.', undefined, 500)
  }
  const activeThread = thread
  if (isNewThread && seedConceptId) {
    // The conversation works without it, so a failed write is logged, not shown.
    await seedTutorConcepts(userId, 'ask', activeThread.id, [seedConceptId]).catch((error) => console.error('[CHAT] Could not seed the concept:', error))
  }
  const storage = createChatStorage(prisma, {
    userId,
    threadId: activeThread.id,
    userMessageId,
    isNewThread,
  })

  const stream = relayChatStream({
    head: [
      { type: 'thread', threadId: activeThread.id, title: activeThread.title, isNew: isNewThread },
      { type: 'user_message', id: userMessageId },
    ],
    upstream,
    storage,
    hooks: declined ? declinedHooks : askHooks({ userId, projectId, threadId: activeThread.id, plan }),
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

/** A declined question is stored as a reply of its own kind, so a reload does not read it as a lookup with no sources. */
const declinedHooks: RelayHooks = {
  onDone: () => ({ tutor: { route: { intent: 'other', broad: false, concepts: [] }, check: null } }),
}

/**
 * Ask's part of the relay: remember the route of the question, store the reply with what it tutored (the check
 * card keeps its answer on the server and the browser is sent the question only), and once the reply is stored
 * move the thread's tutor state and record what the reply taught.
 */
function askHooks(input: { userId: string; projectId: string; threadId: string; plan: AskPlan }): RelayHooks {
  let route: AskRoute | null = null
  let stopReason = ''
  return {
    onEvent(raw) {
      if (raw.type === 'route') route = parseRoute(raw)
    },
    onDone(raw) {
      stopReason = typeof raw.stop_reason === 'string' ? raw.stop_reason : ''
      // Only an explanation after the student's attempt carries a card.
      const card = route?.intent === 'understand' ? parseCard(raw.check_question) : null
      const { check_question: _card, ...rest } = raw
      return {
        tutor: route ? toStoredTutor(route, card) : undefined,
        send: { ...rest, ...(card ? { check_question: browserCard(card) } : {}) },
      }
    },
    async afterSaved(messageId) {
      const finished = await finishAskTurn({ ...input, messageId, route, stopReason, timeZone: await studentTimeZone() })
      return [{ type: 'tutor', workedAllowed: finished.workedAllowed }]
    },
  }
}

export const POST = withClientSignal(handlePOST)
