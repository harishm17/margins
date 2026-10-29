'use client'

import * as React from 'react'
import { toast } from '@/components/ui/toaster'
import { useAiStatus } from '@/features/ai/ai-status'
import { apiFetch, isApiError } from '@/lib/api/client'
import { parseStoredCitations } from '@/lib/chat/citations'
import { applyChatEvent, INITIAL_ANSWER, type AnswerState } from '@/lib/chat/events'
import { chatErrorMessage } from '@/lib/chat/errors'
import {
  retryPlan,
  toChatMessages,
  type AssistantMessage,
  type ChatMessage,
  type FailureMessage,
  type StoredMessage,
} from './chat-messages'
import { ChatRequestError, streamChat } from './chat-client'

export type LiveTurn = { question: string; answer: AnswerState }

type ThreadPayload = { thread: { id: string; title: string | null }; messages: Array<StoredMessage & { citations: unknown }> }

type Options = {
  courseId: string
  /** The topic to focus retrieval on, or null for all materials. */
  topicId: string | null
  initialThreadId?: string | null
  initialMessages?: ChatMessage[]
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
  initialThreadId = null,
  initialMessages = [],
  onThreadStarted,
  onThreadActive,
  onThreadDiscarded,
}: Options) {
  const [threadId, setThreadId] = React.useState<string | null>(initialThreadId)
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages)
  const [live, setLive] = React.useState<LiveTurn | null>(null)
  const [loadingThread, setLoadingThread] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const controllerRef = React.useRef<AbortController | null>(null)
  const threadRef = React.useRef(threadId)
  const loadTokenRef = React.useRef(0)
  const idCounter = React.useRef(0)
  const callbacks = React.useRef({ onThreadStarted, onThreadActive, onThreadDiscarded })

  React.useEffect(() => {
    callbacks.current = { onThreadStarted, onThreadActive, onThreadDiscarded }
    threadRef.current = threadId
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
            setLive({ question, answer })
          },
        })

        if (answer.status === 'done') {
          const message: AssistantMessage = {
            kind: 'assistant',
            id: answer.messageId ?? nextId(),
            text: answer.text,
            marks: answer.marks,
            sources: answer.sources,
            noSources: doneStopReason === 'no_sources' || answer.sources.length === 0,
            notSaved,
            stopped: false,
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
              }
            : null
          finish(partial)
          if (threadRef.current) callbacks.current.onThreadActive?.(threadRef.current)
        } else if (error instanceof ChatRequestError) {
          report(error.code)
          finish(failure(error.message, error.retryable))
        } else {
          const info = chatErrorMessage('CHAT_FAILED')
          finish(failure(info.message, info.retryable))
        }
      }
    },
    [courseId, topicId, nextId, report]
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
      setLoadError(null)
      setLoadingThread(true)
      try {
        const data = await apiFetch<ThreadPayload>(
          `/api/projects/${encodeURIComponent(courseId)}/chat/threads/${encodeURIComponent(id)}`
        )
        if (token !== loadTokenRef.current) return
        setMessages(
          toChatMessages(
            data.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              citations: m.role === 'assistant' ? parseStoredCitations(m.citations) : null,
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

  return { threadId, messages, live, sending, loadingThread, loadError, send, stop, retry, reset, loadThread }
}

export type AskChat = ReturnType<typeof useAskChat>
