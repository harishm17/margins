'use client'

import * as React from 'react'
import { toast } from '@/components/ui/toaster'
import { useAiStatus } from '@/features/ai/ai-status'
import { apiFetch, isApiError } from '@/lib/api/client'
import { parseStoredCitations } from '@/lib/chat/citations'
import { applyChatEvent, INITIAL_ANSWER, type AnswerState } from '@/lib/chat/events'
import { chatErrorMessage } from '@/lib/chat/errors'
import { WORKED_EXAMPLE_REQUEST, type AskTurnView } from '@/lib/ask/tutor-message'
import {
  lacksSources,
  liveTurn,
  retryPlan,
  toChatMessages,
  type AssistantMessage,
  type ChatMessage,
  type FailureMessage,
  type StoredMessage,
} from './chat-messages'
import { ChatRequestError, streamChat } from './chat-client'

export type LiveTurn = { question: string; answer: AnswerState }

type ThreadPayload = {
  thread: { id: string; title: string | null; workedAllowed?: boolean }
  messages: Array<StoredMessage & { citations: unknown; turn?: AskTurnView | null }>
}

type Options = {
  courseId: string
  /** The topic to focus retrieval on, or null for all materials. */
  topicId: string | null
  /** The concept the first question of a new conversation is about; sent only until the conversation exists. */
  conceptId?: string | null
  initialThreadId?: string | null
  initialMessages?: ChatMessage[]
  initialWorkedAllowed?: boolean
  /** A new conversation was created by the first question. */
  onThreadStarted?: (thread: { id: string; title: string | null }) => void
  /** The conversation got a new answer (or a stopped one): move it to the top of the list. */
  onThreadActive?: (threadId: string) => void
  /** The first question of a new conversation failed, so the server removed the conversation. */
  onThreadDiscarded?: (threadId: string) => void
}

/**
 * The state of one conversation: stored messages, the answer being streamed, and the
 * actions on them. The same hook drives the full page and the sheet.
 */
export function useAskChat({
  courseId,
  topicId,
  conceptId = null,
  initialThreadId = null,
  initialMessages = [],
  initialWorkedAllowed = false,
  onThreadStarted,
  onThreadActive,
  onThreadDiscarded,
}: Options) {
  const [threadId, setThreadId] = React.useState<string | null>(initialThreadId)
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages)
  const [live, setLive] = React.useState<LiveTurn | null>(null)
  const [loadingThread, setLoadingThread] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  // The thread has had a genuine attempt, so "Show me a worked example" may be offered.
  const [workedAllowed, setWorkedAllowed] = React.useState(initialWorkedAllowed)

  const controllerRef = React.useRef<AbortController | null>(null)
  const threadRef = React.useRef(threadId)
  const loadTokenRef = React.useRef(0)
  const idCounter = React.useRef(0)
  const callbacks = React.useRef({ onThreadStarted, onThreadActive, onThreadDiscarded })

  const messagesRef = React.useRef(messages)
  React.useEffect(() => {
    callbacks.current = { onThreadStarted, onThreadActive, onThreadDiscarded }
    threadRef.current = threadId
    messagesRef.current = messages
  })

  const nextId = React.useCallback(() => `local-${Date.now()}-${(idCounter.current += 1)}`, [])
  // A refusal or failure that means AI is unavailable (or the allowance is used) turns the
  // composer and every other AI button off at once.
  const { report } = useAiStatus()

  const sending = live !== null

  const abortCurrent = React.useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  // Leaving the page stops reading; the server still stores the answer.
  React.useEffect(() => () => controllerRef.current?.abort(), [])

  /**
   * A reply the student stopped is kept as far as it was read, but the server finishes writing it and stores it with its
   * check question. Once it is stored, show the stored reply (full text, with its card) in place of the partial one.
   */
  const attachStored = React.useCallback(
    async (id: string) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        if (controllerRef.current || threadRef.current !== id) return
        try {
          const data = await apiFetch<ThreadPayload>(`/api/projects/${encodeURIComponent(courseId)}/chat/threads/${encodeURIComponent(id)}`)
          const shown = messagesRef.current.filter((message) => message.kind === 'assistant').length
          if (data.messages.filter((message) => message.role === 'assistant').length < shown) continue
          if (controllerRef.current || threadRef.current !== id) return
          setWorkedAllowed(data.thread.workedAllowed === true)
          setMessages(
            toChatMessages(
              data.messages.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                citations: m.role === 'assistant' ? parseStoredCitations(m.citations) : null,
                turn: m.turn ?? null,
              }))
            )
          )
          return
        } catch {
          return
        }
      }
    },
    [courseId]
  )

  const send = React.useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question || controllerRef.current) return

      const controller = new AbortController()
      controllerRef.current = controller
      setMessages((current) => [...current, { kind: 'user', id: nextId(), text: question }])

      let answer: AnswerState = INITIAL_ANSWER
      let doneStopReason = null as string | null
      let notSaved = false
      // The conversation this question started, if it started one.
      let startedThread: string | null = null
      setLive({ question, answer })

      const finish = (message: ChatMessage | null) => {
        controllerRef.current = null
        setLive(null)
        if (message) setMessages((current) => [...current, message])
      }
      const failure = (message: string, retryable: boolean): FailureMessage => ({
        kind: 'failure',
        id: nextId(),
        message,
        retryable,
        question,
      })

      try {
        await streamChat({
          courseId,
          question,
          threadId: threadRef.current,
          topicId,
          conceptId: threadRef.current ? null : conceptId,
          // The button's message is the one fixed sentence, so a retry of it is the button again.
          ...(question === WORKED_EXAMPLE_REQUEST ? { event: 'show_worked' as const } : {}),
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'thread') {
              threadRef.current = event.threadId
              setThreadId(event.threadId)
              if (event.isNew) {
                startedThread = event.threadId
                callbacks.current.onThreadStarted?.({ id: event.threadId, title: event.title })
              }
              return
            }
            // The server removed the failed question; a conversation it started is gone too, so
            // the retry starts a new one.
            if (event.type === 'error' && event.discarded && startedThread) {
              const gone = startedThread
              startedThread = null
              threadRef.current = null
              setThreadId(null)
              callbacks.current.onThreadDiscarded?.(gone)
            }
            if (event.type === 'user_message') return
            if (event.type === 'done') doneStopReason = event.stopReason
            // An error after the answer arrived means only the saving failed.
            if (event.type === 'error' && doneStopReason !== null) {
              notSaved = true
              return
            }
            answer = applyChatEvent(answer, event)
            if (event.type === 'tutor') setWorkedAllowed(event.workedAllowed)
            setLive({ question, answer })
          },
        })

        if (answer.status === 'done') {
          const turn = liveTurn(answer.route, answer.check)
          const message: AssistantMessage = {
            kind: 'assistant',
            id: answer.messageId ?? nextId(),
            text: answer.text,
            marks: answer.marks,
            sources: answer.sources,
            noSources: lacksSources(turn, answer.sources.length === 0, doneStopReason ?? ''),
            notSaved,
            stopped: false,
            turn,
          }
          finish(message)
          if (threadRef.current) callbacks.current.onThreadActive?.(threadRef.current)
        } else if (answer.status === 'error' && answer.error) {
          report(answer.error.code)
          finish(failure(answer.error.message, answer.error.retryable))
        } else {
          const info = chatErrorMessage('CHAT_INTERRUPTED')
          finish(failure(info.message, info.retryable))
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Stopped by the student. Keep what was written; the stored answer is complete.
          const partial: AssistantMessage | null = answer.text
            ? {
                kind: 'assistant',
                id: nextId(),
                text: answer.text,
                marks: answer.marks,
                sources: answer.sources,
                noSources: false,
                notSaved: false,
                stopped: true,
                turn: liveTurn(answer.route, answer.check),
              }
            : null
          finish(partial)
          if (threadRef.current) callbacks.current.onThreadActive?.(threadRef.current)
          // An explanation ends with a check question the stopped reply never showed.
          if (partial && answer.route?.intent === 'understand' && threadRef.current) void attachStored(threadRef.current)
        } else if (error instanceof ChatRequestError) {
          report(error.code)
          finish(failure(error.message, error.retryable))
        } else {
          const info = chatErrorMessage('CHAT_FAILED')
          finish(failure(info.message, info.retryable))
        }
      }
    },
    [courseId, topicId, conceptId, nextId, report, attachStored]
  )

  /** Stop the answer. The server keeps writing it to the conversation. */
  const stop = React.useCallback(() => {
    if (!controllerRef.current) return
    abortCurrent()
    toast('The answer will still be saved.')
  }, [abortCurrent])

  /** Ask a failed question again, at the end of the conversation (see retryPlan). */
  const retry = React.useCallback(
    (failureId: string) => {
      const plan = retryPlan(messages, failureId)
      if (!plan) return
      setMessages(plan.messages)
      void send(plan.question)
    },
    [messages, send]
  )

  /** Start an empty conversation. */
  const reset = React.useCallback(() => {
    abortCurrent()
    loadTokenRef.current += 1
    setLive(null)
    setMessages([])
    setThreadId(null)
    threadRef.current = null
    setLoadError(null)
    setLoadingThread(false)
    setWorkedAllowed(false)
  }, [abortCurrent])

  /** Open a stored conversation. */
  const loadThread = React.useCallback(
    async (id: string) => {
      abortCurrent()
      setLive(null)
      const token = (loadTokenRef.current += 1)
      setThreadId(id)
      threadRef.current = id
      setMessages([])
      setWorkedAllowed(false)
      setLoadError(null)
      setLoadingThread(true)
      try {
        const data = await apiFetch<ThreadPayload>(
          `/api/projects/${encodeURIComponent(courseId)}/chat/threads/${encodeURIComponent(id)}`
        )
        if (token !== loadTokenRef.current) return
        setWorkedAllowed(data.thread.workedAllowed === true)
        setMessages(
          toChatMessages(
            data.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              citations: m.role === 'assistant' ? parseStoredCitations(m.citations) : null,
              turn: m.turn ?? null,
            }))
          )
        )
      } catch (error) {
        if (token !== loadTokenRef.current) return
        setLoadError(isApiError(error) ? error.message : 'Could not open that conversation. Try again.')
      } finally {
        if (token === loadTokenRef.current) setLoadingThread(false)
      }
    },
    [courseId, abortCurrent]
  )

  return { threadId, messages, live, sending, loadingThread, loadError, workedAllowed, send, stop, retry, reset, loadThread }
}

export type AskChat = ReturnType<typeof useAskChat>
