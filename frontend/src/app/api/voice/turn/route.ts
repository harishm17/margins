/**
 * POST /api/voice/turn: one exchange with the voice coach.
 *
 * Body: { sessionId, utterance }. The browser does speech-to-text and text-to-speech; this
 * route runs the text conversation with Claude (through the AI service), runs the drill tools
 * on the server, keeps the conversation on the session, and answers with newline-delimited
 * JSON events (see src/lib/voice/turn-client.ts). Problems found before the reply starts are
 * ordinary JSON errors.
 */
import { logServerError } from '@/lib/ops/log'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { requireAuth } from '@/lib/auth/get-session'
import { prisma } from '@/lib/db/prisma'
import {
  ApiErrorCode,
  apiError,
  apiInternal,
  apiNotFound,
  apiUnauthorized,
  isUnauthorizedError,
} from '@/lib/api/errors'
import { createRateLimiter } from '@/lib/api/rate-limit'
import { withClientSignal } from '@/lib/ai-service/client-signal'
import { voiceTurnsPerMinute } from '@/lib/voice/turn-limit'
import {
  VoiceModelError,
  modelErrorFromResponse,
  readModelEvents,
  requestModelTurn,
} from '@/lib/voice/ai-turn'
import { claimVoiceSession, claimVoiceTurn, isSerializationConflict, keepVoiceTurn, releaseVoiceTurn } from '@/lib/voice/claim'
import {
  coachStyleOf,
  CONTINUE_MESSAGE,
  buildCoachSystemPrompt,
  startMessage,
  styleUsesTools,
  type CoachStyle,
} from '@/lib/voice/coach-prompt'
import { courseTermsForTopics, sessionTopicIds } from '@/lib/voice/course-terms'
import { extractTextFromNotes } from '@/lib/voice/concept'
import { voiceErrorMessage } from '@/lib/voice/errors'
import { MAX_HEARD_CHARS, appendCutOffReply, appendUserText, markInterrupted, parseHistory, toStoredHistory, type VoiceMessage } from '@/lib/voice/history'
import { listenForSession } from '@/lib/voice/listen'
import { attachClientTiming, clientTimingSchema, recordTurnTiming } from '@/lib/voice/turn-timing'
import { planPreRunForSession, startWithPreRun } from '@/lib/voice/pre-run-server'
import { beginVoiceTurn } from '@/lib/voice/teach-tools'
import { executeVoiceTool, toolsForStyle, type StepCache } from '@/lib/voice/tools'
import { promptsV2 } from '@/lib/prompt-revision'
import { neutralizeAppResultTags } from '@/lib/voice/pre-run'
import type { VoiceStreamExtra } from '@/lib/voice/turn-contract'
import { getTimeZone } from '@/server/timezone'
import { runTurn } from '@/lib/voice/turn-engine'
import type { VoiceEvent } from '@/lib/voice/turn-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_UTTERANCE_CHARS = 2000

// Every turn is at least one model call.
const turnLimiter = createRateLimiter({ name: 'voice-turn', limit: voiceTurnsPerMinute(), windowMs: 60_000 })

const bodySchema = z.object({
  sessionId: id(),
  // Empty (or missing) means "start the session" the first time, "carry on" afterwards.
  utterance: z.string().trim().max(MAX_UTTERANCE_CHARS, `Keep it under ${MAX_UTTERANCE_CHARS} characters`).default(''),
  // The student interrupted the coach's last reply: what they heard of it before it stopped (spec 19.4).
  interruptedHeard: z.string().max(MAX_HEARD_CHARS).optional(),
  // What the browser measured for the previous turn (spec 19.10).
  timing: clientTimingSchema.optional(),
  // The same words again after a turn that failed before the coach said or did anything: they are not counted twice.
  retry: z.boolean().optional(),
})

/** A JSON error in the B shape, with the friendly message for `code` and the code in details. */
function voiceFailure(code: string, extraDetails: Record<string, unknown> = {}, retryable?: boolean) {
  const info = voiceErrorMessage(code)
  const apiCode =
    code === 'LLM_DAILY_BUDGET' || code === 'RATE_LIMITED' || code === 'VOICE_DAILY_LIMIT'
      ? ApiErrorCode.RATE_LIMITED
      : code === 'SESSION_ENDED' || code === 'ACTIVE_SESSION' || code === 'TURN_IN_PROGRESS'
        ? ApiErrorCode.CONFLICT
        : code === 'PROJECT_NOT_FOUND'
          ? ApiErrorCode.NOT_FOUND
          : ApiErrorCode.UPSTREAM_ERROR
  return apiError(apiCode, info.message, { code, retryable: retryable ?? info.retryable, ...extraDetails }, info.status)
}

/** What the coach needs to know about the session's topic or sprint, read fresh each turn. */
async function loadPromptContext(userId: string, session: { mode: string; topicId: string | null; questionSet: Prisma.JsonValue }) {
  const courseTerms = await courseTermsForTopics(userId, sessionTopicIds(session))
  if (session.mode === 'sprint') {
    const ids = new Set<string>()
    if (Array.isArray(session.questionSet)) {
      for (const question of session.questionSet as Array<{ topic_id?: unknown }>) {
        if (typeof question?.topic_id === 'string' && question.topic_id) ids.add(question.topic_id)
      }
    }
    const topics = ids.size
      ? await prisma.topic.findMany({
          where: { id: { in: [...ids] }, project: { userId } },
          select: { name: true },
          orderBy: { orderIndex: 'asc' },
        })
      : []
    return { topicName: null, topicDescription: null, notes: null, sprintTopics: topics.map((topic) => topic.name), courseTerms }
  }
  const topic = session.topicId
    ? await prisma.topic.findFirst({
        where: { id: session.topicId, project: { userId } },
        select: {
          name: true,
          description: true,
          content: { where: { contentType: 'section_notes' }, select: { contentData: true }, take: 1 },
        },
      })
    : null
  return {
    topicName: topic?.name ?? null,
    topicDescription: topic?.description ?? null,
    notes: topic?.content[0] ? extractTextFromNotes(topic.content[0].contentData) : null,
    sprintTopics: [] as string[],
    courseTerms,
  }
}

async function handlePost(request: NextRequest) {
  const requestStarted = performance.now()
  let userId: string
  try {
    userId = (await requireAuth()).user.id
  } catch (error) {
    if (isUnauthorizedError(error)) return apiUnauthorized()
    logServerError('Voice: Auth failed', error)
    return apiInternal('Failed to start the turn')
  }

  const limit = await turnLimiter.check(userId)
  if (!limit.ok) {
    const response = voiceFailure('RATE_LIMITED')
    response.headers.set('Retry-After', String(limit.retryAfterSeconds))
    return response
  }

  const parsed = await readJson(request, bodySchema)
  if (!parsed.ok) return parsed.response
  const { sessionId, utterance, interruptedHeard, timing, retry } = parsed.data

  const session = await prisma.voiceDrillSession.findFirst({ where: { id: sessionId, userId } })
  if (!session) return apiNotFound('Session not found')
  if (session.status !== 'active' || session.endedAt) return voiceFailure('SESSION_ENDED')

  // One turn at a time per session, across server processes (a conditional update on the session row).
  if (!(await claimVoiceTurn(userId, session.id))) return voiceFailure('TURN_IN_PROGRESS')
  let claimedHere = false
  // The claim is renewed while the turn runs, and the reply stream (once there is one) gets a keep-alive line each time.
  let keepAlive: (() => void) | null = null
  const stopRenewing = keepVoiceTurn(userId, session.id, () => keepAlive?.())
  const releaseTurn = () => {
    stopRenewing()
    return releaseVoiceTurn(userId, session.id)
  }
  // Aborted when the browser leaves: the model call stops instead of finishing an answer nobody will hear.
  const turnAbort = new AbortController()
  // A failed first turn must not leave the session counted as connected.
  const releaseClaim = async () => {
    if (!claimedHere) return
    claimedHere = false
    await prisma.voiceDrillSession
      .update({ where: { id: session.id }, data: { connectedAt: null, lastSeenAt: null } })
      .catch((error) => logServerError('Voice: Could not release the session claim', error))
  }

  try {
    // Every turn: one live session per user and the daily cap, checked again as the session's own minutes run (a cap read
    // only on the first turn let a student with a minute left talk for an hour). The same call keeps the session live.
    const claim = await claimVoiceSession(session)
    if (!claim.ok) {
      await releaseTurn()
      return claim.reason === 'busy'
        ? voiceFailure('ACTIVE_SESSION')
        : voiceFailure('VOICE_DAILY_LIMIT', { remainingSeconds: 0, dailyMinutes: claim.capMinutes })
    }
    claimedHere = !session.connectedAt

    // A session from before teach-back and guided reading carries on in the style it began with.
    const style: CoachStyle = coachStyleOf(session.style)
    const context = await loadPromptContext(userId, session)
    const system = buildCoachSystemPrompt({
      mode: session.mode === 'sprint' ? 'sprint' : 'topic_drill',
      style,
      language: session.language,
      focus: session.focus,
      ...context,
    })
    const tools = styleUsesTools(style) ? toolsForStyle(style) : []
    // Read here: the cookie is not reachable once the response stream is running.
    const timeZone = await getTimeZone()

    // An interrupted reply is stored as what the student heard and a note, so the model does not take the rest as said.
    const stored = parseHistory(session.history)
    const history = interruptedHeard !== undefined ? markInterrupted(stored, interruptedHeard) : stored
    // Kept at once: the browser reports an interruption one time, and a turn that fails before anything is said stores
    // nothing, which would lose the mark and leave the model thinking the whole reply was heard.
    if (interruptedHeard !== undefined) {
      await prisma.voiceDrillSession.update({
        where: { id: session.id },
        data: { history: toStoredHistory(history) as unknown as Prisma.InputJsonValue },
      })
    }
    // With PROMPTS_V2 the student's words cannot pass for an app_result (prompt audit L3).
    const spoken = promptsV2('voice') ? neutralizeAppResultTags(utterance) : utterance
    const userText = spoken || (history.length === 0 ? startMessage(style, context.topicName, promptsV2('voice')) : CONTINUE_MESSAGE)
    // The server keeps what the student said, with this turn's number: the tools take an answer from there, not from the model.
    const turn = await beginVoiceTurn(session.id, utterance, { retry: retry === true })
    if (timing) void attachClientTiming(session.id, turn, timing)
    let startMessages: VoiceMessage[] = appendUserText(history, userText)
    // The step the session is waiting for runs before the model speaks (spec 19.1), in the stream below so the browser can be
    // told at once; the model is then called once, with the result in the student's message.
    const steps: StepCache = new Map()
    // Work a step leaves for later (what a recorded answer does to mastery and the schedule): the reply does not wait for
    // it, the end of the turn does.
    const deferred: Promise<void>[] = []
    const defer = (work: Promise<void>) => void deferred.push(work)
    const preRun = await planPreRunForSession({ userId, sessionId: session.id, language: session.language, utterance, history })

    const modelRequest = (messages: VoiceMessage[]) =>
      requestModelTurn({ userId, projectId: session.projectId, sessionId: session.id, system, messages, tools }, turnAbort.signal)

    // Ask first, unless a step has to run first. When the AI service refuses (daily budget) or is down, the session keeps its
    // old conversation and the browser gets an ordinary JSON error.
    let firstBody: ReadableStream<Uint8Array> | null = null
    let firstCallStarted: number | undefined
    if (!preRun) {
      let first: Response
      try {
        firstCallStarted = performance.now()
        first = await modelRequest(startMessages)
      } catch (error) {
        logServerError('Voice: The AI service is not reachable', error)
        await releaseClaim()
        await releaseTurn()
        return voiceFailure('VOICE_UNAVAILABLE')
      }
      if (!first.ok || !first.body) {
        const failure = await modelErrorFromResponse(first)
        logServerError('Voice: the AI service refused the turn', undefined, { code: failure.code, retryable: failure.retryable })
        await releaseClaim()
        await releaseTurn()
        return voiceFailure(failure.code, {}, failure.retryable)
      }
      firstBody = first.body
    }

    const encoder = new TextEncoder()
    let clientGone = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let firstTextAt: number | null = null
        const send = (event: VoiceEvent | VoiceStreamExtra) => {
          if (event.type === 'text' && firstTextAt === null) firstTextAt = performance.now()
          if (clientGone) return
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          } catch {
            clientGone = true
          }
        }
        const sendError = (code: string) => {
          const info = voiceErrorMessage(code)
          send({ type: 'error', code, message: info.message, retryable: info.retryable })
        }
        keepAlive = () => send({ type: 'alive' })

        void (async () => {
          try {
            let preRan = false
            let preRunMs = 0
            if (preRun) {
              const stepStarted = performance.now()
              startMessages = (await startWithPreRun(preRun, { sessionId: session.id, userId, timeZone, turn, steps, defer }, startMessages, send)).messages
              preRunMs = performance.now() - stepStarted
              preRan = true
            }
            const outcome = await runTurn(
              {
                async openModel(messages, callNumber) {
                  if (callNumber === 1 && firstBody) return readModelEvents(firstBody)
                  let response: Response
                  try {
                    response = await modelRequest(messages)
                  } catch (error) {
                    logServerError('Voice: The AI service is not reachable', error)
                    throw new VoiceModelError('VOICE_UNAVAILABLE', 'The AI service is not reachable', true)
                  }
                  if (!response.ok || !response.body) throw await modelErrorFromResponse(response)
                  return readModelEvents(response.body)
                },
                runTool: (name, input) => executeVoiceTool({ sessionId: session.id, userId, timeZone, turn, steps, defer }, name, input),
                emit: send,
                retryCutOff: promptsV2('voice'),
                callStartedAt: (call) => (call === 1 ? firstCallStarted : undefined),
              },
              startMessages
            )
            await Promise.all(deferred)
            await recordTurnTiming({
              sessionId: session.id,
              userId,
              turn,
              style,
              preRun: preRun?.step ?? null,
              graded: (preRan && preRun?.step !== 'start') || steps.size > 0,
              calls: outcome.calls,
              stepMs: preRunMs + outcome.toolMs,
              firstTextMs: firstTextAt === null ? null : firstTextAt - requestStarted,
              totalMs: performance.now() - requestStarted,
              ok: outcome.ok,
            })

            // Keep the conversation when the turn worked, when it failed after tools had already recorded something (a
            // retry must not record it twice), and when it failed or was interrupted after the coach had started to
            // speak: the student heard that, so it is part of the conversation. A reply that did not finish is stored
            // as cut off, where the next turn's "what the student heard" finds it.
            let saved = true
            if (outcome.ok || outcome.toolsRan || preRan || outcome.text) {
              try {
                await prisma.voiceDrillSession.update({
                  where: { id: session.id },
                  data: {
                    history: toStoredHistory(appendCutOffReply(outcome.messages, outcome.cutOff)) as unknown as Prisma.InputJsonValue,
                    lastSeenAt: new Date(),
                  },
                })
              } catch (error) {
                logServerError('Voice: Could not store the conversation', error)
                saved = false
              }
            } else {
              await releaseClaim()
            }

            if (outcome.ok) {
              if (saved) {
                // What the session waits for next, so the browser can set its end-of-turn wait.
                send({ type: 'listen', for: await listenForSession(userId, session.id).catch(() => 'short_answer' as const) })
                send({ type: 'done', text: outcome.text })
              } else sendError('VOICE_NOT_SAVED')
            }
            // A failed turn has already sent its error event.
          } catch (error) {
            logServerError('Voice: The turn crashed', error)
            sendError('VOICE_TURN_FAILED')
          } finally {
            // Deferred work catches its own failures; a turn that crashed still waits for it before the next may start.
            await Promise.allSettled(deferred)
            await releaseTurn()
            try {
              controller.close()
            } catch {
              // Already closed because the browser went away.
            }
          }
        })()
      },
      cancel() {
        // The browser left: stop the model call. The turn ends through its usual failure path, which keeps what the
        // tools already recorded.
        clientGone = true
        turnAbort.abort()
      },
    })

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    await releaseTurn()
    await releaseClaim()
    if (isSerializationConflict(error)) return voiceFailure('TURN_IN_PROGRESS')
    logServerError('Voice: Turn failed', error)
    return apiInternal('Failed to run the turn')
  }
}

export const POST = withClientSignal(handlePost)
