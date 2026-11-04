'use client'

import * as React from 'react'
import { ArrowClockwise, Info } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { Spinner } from '@/components/ui/spinner'
import { insertCitationMarkers, type ChatSource, type CitationMark } from '@/lib/chat/citations'
import { cn } from '@/lib/utils'
import { CheckCard } from './check-card'
import { CitationPill, SourcesList } from './citations'
import { sourceByMarker, type AssistantMessage, type FailureMessage } from './chat-messages'
import type { LiveTurn } from './use-ask-chat'

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-card bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-fg">
        <span className="sr-only">You: </span>
        {text}
      </div>
    </div>
  )
}

const READING_16 = '!text-[16px] !leading-[27px]'

/** An answer's text with its citation pills. */
function AnswerBody({
  text,
  marks,
  sources,
  streaming,
}: {
  text: string
  marks: readonly CitationMark[]
  sources: readonly ChatSource[]
  streaming?: boolean
}) {
  const withMarkers = React.useMemo(() => insertCitationMarkers(text, marks), [text, marks])
  const renderCitation = React.useCallback(
    (marker: number) => <CitationPill marker={marker} source={sourceByMarker(sources, marker)} />,
    [sources]
  )
  return (
    <div
      className={cn(
        streaming &&
          '[&_.md>:last-child]:after:ml-0.5 [&_.md>:last-child]:after:inline-block [&_.md>:last-child]:after:h-[1em] [&_.md>:last-child]:after:w-[2px] [&_.md>:last-child]:after:translate-y-[0.15em] [&_.md>:last-child]:after:bg-accent [&_.md>:last-child]:after:align-baseline [&_.md>:last-child]:after:content-[""] [&_.md>:last-child]:after:animate-caret'
      )}
    >
      <LazyMarkdown variant="reading" className={READING_16} renderCitation={renderCitation}>
        {withMarkers}
      </LazyMarkdown>
    </div>
  )
}

function AssistantLabel() {
  return <p className="mb-1.5 text-caption text-fg-3">Margins</p>
}

/** The intents whose replies can be followed by "Show me a worked example": the student is working a problem. */
const WORKING_INTENTS = new Set(['solve', 'check_answer'])

export type NextMoves = {
  /** This is the last reply of the conversation, the only one its follow-up buttons belong to. */
  last: boolean
  /** The thread has had a genuine attempt, so the worked example may be asked for. */
  workedAllowed: boolean
  disabled: boolean
  onAsk: (question: string) => void
  onWorked: () => void
}

export function AssistantBlock({ message, moves }: { message: AssistantMessage; moves?: NextMoves }) {
  const turn = message.turn
  const entryPoints = moves?.last && turn ? turn.entryPoints : []
  return (
    <article className="min-w-0">
      <AssistantLabel />
      <AnswerBody text={message.text} marks={message.marks} sources={message.sources} />
      <SourcesList sources={message.sources} />
      {entryPoints.length > 0 ? (
        <div role="group" aria-label="Places to start" className="mt-4 flex flex-wrap gap-2">
          {entryPoints.map((name) => (
            <Button key={name} size="sm" variant="secondary" disabled={moves?.disabled} onClick={() => moves?.onAsk(`Explain ${name}`)}>
              {name}
            </Button>
          ))}
        </div>
      ) : null}
      {turn?.check && !message.notSaved ? <CheckCard messageId={message.id} check={turn.check} bringIntoView={!!moves?.last} /> : null}
      {moves?.last && moves.workedAllowed && turn && WORKING_INTENTS.has(turn.intent) ? (
        <div className="mt-4">
          <Button size="sm" variant="secondary" disabled={moves.disabled} onClick={moves.onWorked}>
            Show me a worked example
          </Button>
        </div>
      ) : null}
      {message.stopped ? (
        <p className="mt-3 text-small text-fg-3">Stopped early. The full answer is saved in this conversation.</p>
      ) : null}
      {message.noSources ? (
        <InlineAlert className="mt-4" tone="neutral">
          Nothing in your materials matched closely. Try naming an idea from your notes.
        </InlineAlert>
      ) : null}
      {message.notSaved ? (
        <InlineAlert className="mt-4" tone="warning" icon={<Info />}>
          The answer could not be saved to this conversation. It is shown here only.
        </InlineAlert>
      ) : null}
    </article>
  )
}

/** The answer in progress: "Searching your materials...", then text with a caret. */
export function LiveAnswer({ turn }: { turn: LiveTurn }) {
  const { answer } = turn
  const writing = answer.status === 'writing' || answer.status === 'done'
  return (
    <article className="min-w-0" aria-busy={answer.status !== 'done'}>
      <AssistantLabel />
      {writing && answer.text ? (
        <div aria-live="polite">
          <AnswerBody text={answer.text} marks={answer.marks} sources={answer.sources} streaming={answer.status === 'writing'} />
        </div>
      ) : (
        <p role="status" className="flex items-center gap-2 text-body text-fg-2">
          <Spinner className="text-accent" />
          {answer.stage === 'checking' ? 'Checking the reply...' : answer.stage === 'writing' ? 'Writing the reply...' : 'Searching your materials...'}
        </p>
      )}
    </article>
  )
}

export function FailureBlock({ message, onRetry, disabled }: { message: FailureMessage; onRetry: () => void; disabled?: boolean }) {
  return (
    <InlineAlert
      tone="danger"
      action={
        message.retryable && message.question ? (
          <Button size="sm" variant="secondary" icon={<ArrowClockwise />} onClick={onRetry} disabled={disabled}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {message.message}
    </InlineAlert>
  )
}
