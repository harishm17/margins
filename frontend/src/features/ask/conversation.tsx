'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChatCircleText, Files, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { InlineAlert } from '@/components/ui/inline-alert'
import type { SelectOption } from '@/components/ui/select'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Composer } from './composer'
import { AssistantBlock, FailureBlock, LiveAnswer, UserBubble } from './messages'
import type { AskChat } from './use-ask-chat'
import { useAiStatus } from '@/features/ai/ai-status'

type ConversationProps = {
  chat: AskChat
  courseId: string
  variant: 'page' | 'sheet'
  hasMaterials: boolean
  /** Fills the question box without sending it. */
  initialDraft?: string
  examples: string[]
  scopeOptions?: SelectOption[]
  scope?: string
  onScopeChange?: (scope: string) => void
  fixedScope?: string
  /** Shown in the sheet's empty state, e.g. "Graph traversal". */
  topicName?: string
}

const NEAR_BOTTOM = 160

/** Messages, empty states and the composer. The page and the sheet both render this. */
export function Conversation({
  chat,
  courseId,
  variant,
  hasMaterials,
  initialDraft,
  examples,
  scopeOptions,
  scope,
  onScopeChange,
  fixedScope,
  topicName,
}: ConversationProps) {
  const { messages, live, sending, loadingThread, loadError, send, stop, retry } = chat
  const { blocked } = useAiStatus()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const stickRef = React.useRef(true)
  const isSheet = variant === 'sheet'

  const empty = messages.length === 0 && !live && !loadingThread && !loadError
  const noMaterials = !hasMaterials && empty
  const liveLength = live?.answer.text.length ?? 0

  // Follow the answer while the student is at the bottom; leave them alone once they scroll up.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, liveLength, live?.answer.status])

  // Escape stops an answer wherever the focus is.
  React.useEffect(() => {
    if (!sending) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sending, stop])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
  }

  const ask = (question: string) => {
    stickRef.current = true
    void send(question)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto flex min-h-full w-full max-w-[720px] flex-col px-4 py-6', !isSheet && 'md:px-6')}>
          {loadingThread ? (
            <div aria-busy="true" aria-label="Loading conversation" className="flex flex-col gap-8">
              <Skeleton className="ml-auto h-10 w-2/3 rounded-card" />
              <SkeletonText lines={5} />
            </div>
          ) : loadError ? (
            <InlineAlert tone="danger" icon={<WarningCircle />}>
              {loadError}
            </InlineAlert>
          ) : noMaterials ? (
            <div className="my-auto">
              <EmptyState
                icon={<Files />}
                title="Add materials to start asking"
                action={
                  <Button asChild variant="primary">
                    <Link href={`/courses/${courseId}/materials`}>Go to materials</Link>
                  </Button>
                }
              >
                Answers come only from your files. Upload your lecture notes first, then ask away.
              </EmptyState>
            </div>
          ) : empty ? (
            <div className="my-auto flex flex-col items-center py-8 text-center">
              {isSheet ? (
                <>
                  <span aria-hidden="true" className="grid size-10 place-items-center rounded-card bg-surface-2 text-fg-2 [&>svg]:size-5">
                    <ChatCircleText />
                  </span>
                  <h2 className="mt-4 text-subheading text-fg">Ask about {topicName ?? 'this topic'}</h2>
                </>
              ) : (
                <h2 className="text-title text-fg">Ask your materials</h2>
              )}
              <p className="mt-1.5 max-w-[52ch] text-body text-fg-2">Answers come only from your files, with sources.</p>
              <ul className="mt-6 flex w-full max-w-[560px] flex-col gap-2">
                {examples.map((question) => (
                  <li key={question}>
                    <button
                      type="button"
                      onClick={() => ask(question)}
                      className="w-full rounded-control border border-border bg-surface px-3.5 py-2.5 text-left text-body text-fg-2 transition-[background-color,border-color,color] duration-120 hover:border-border-strong hover:bg-surface-2 hover:text-fg max-sm:py-3"
                    >
                      {question}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {messages.map((message) =>
                message.kind === 'user' ? (
                  <UserBubble key={message.id} text={message.text} />
                ) : message.kind === 'assistant' ? (
                  <AssistantBlock key={message.id} message={message} />
                ) : (
                  <FailureBlock key={message.id} message={message} disabled={sending || !!blocked} onRetry={() => retry(message.id)} />
                )
              )}
              {live ? <LiveAnswer turn={live} /> : null}
            </div>
          )}
        </div>
      </div>

      {noMaterials ? null : (
        <div className={cn('shrink-0 px-4 pb-4 pt-2', !isSheet && 'md:px-6 md:pb-6')}>
          <div className="mx-auto w-full max-w-[720px]">
            <Composer
              onSend={ask}
              onStop={stop}
              sending={sending}
              scopeOptions={scopeOptions}
              scope={scope}
              onScopeChange={onScopeChange}
              fixedScope={fixedScope}
              disabled={loadingThread}
              autoFocus={!isSheet}
              initialValue={initialDraft}
            />
          </div>
        </div>
      )}
    </div>
  )
}
