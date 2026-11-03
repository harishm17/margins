'use client'

import * as React from 'react'
import { Lightbulb } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { MathText } from '@/components/ui/math-text'
import { cn } from '@/lib/utils'
import { evaluationBadge, type CoachEntry, type TranscriptEntry } from './session-state'

type TranscriptProps = {
  entries: TranscriptEntry[]
  /** What the recognizer has heard so far, not yet sent. */
  interim: string
  className?: string
}

/**
 * The conversation so far. About six turns fit; older ones scroll. Coach turns are full
 * strength, the student's are quieter, interim recognition is italic and lighter.
 */
export function Transcript({ entries, interim, className }: TranscriptProps) {
  const scroller = React.useRef<HTMLDivElement>(null)
  const last = entries[entries.length - 1]
  const lastLength = last && last.role === 'coach' ? last.text.length : 0

  React.useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries.length, lastLength, interim])

  const visible = entries.filter((entry) => entry.role === 'student' || hasContent(entry))

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      data-testid="voice-transcript"
      className={cn('max-h-[22rem] min-h-24 overflow-y-auto py-1 pr-1', className)}
    >
      {visible.length === 0 && !interim ? (
        <p className="py-6 text-center text-small text-fg-3">The conversation shows up here.</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {visible.map((entry) =>
            entry.role === 'student' ? <StudentTurn key={entry.id} text={entry.text} /> : <CoachTurn key={entry.id} entry={entry} />
          )}
          {interim ? (
            <li className="grid grid-cols-[3.25rem_1fr] gap-x-3">
              <span className="pt-0.5 text-caption text-fg-3">You</span>
              <p className="text-body italic text-fg-3" data-testid="voice-interim">
                {interim}
              </p>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  )
}

function hasContent(entry: CoachEntry) {
  return entry.text.trim() !== '' || !!entry.evaluation || !!entry.hint
}

function StudentTurn({ text }: { text: string }) {
  return (
    <li className="grid grid-cols-[3.25rem_1fr] gap-x-3">
      <span className="pt-0.5 text-caption text-fg-3">You</span>
      <p className="text-body text-fg-2">{text}</p>
    </li>
  )
}

function CoachTurn({ entry }: { entry: CoachEntry }) {
  const badge = entry.evaluation ? evaluationBadge(entry.evaluation) : null
  return (
    <li className="grid grid-cols-[3.25rem_1fr] gap-x-3" data-testid="voice-coach-turn">
      <span className="pt-0.5 text-caption text-fg-3">Coach</span>
      <div className="min-w-0">
        {entry.text.trim() ? (
          <p className={cn('text-body', entry.note ? 'text-fg-2' : 'text-fg')} data-testid={entry.note ? 'voice-coach-note' : undefined}>
            {entry.text.trim()}
            {entry.streaming ? (
              <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-caret bg-fg-3" />
            ) : null}
            {entry.interrupted ? <span className="text-fg-3">{' '}(interrupted)</span> : null}
          </p>
        ) : null}
        {entry.evaluation && badge ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="voice-evaluation">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {entry.evaluation.comment ? (
              <span className="text-small text-fg-2">
                <MathText>{entry.evaluation.comment}</MathText>
              </span>
            ) : null}
          </div>
        ) : null}
        {entry.hint ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="voice-hint">
            <Badge tone="neutral" icon={<Lightbulb />}>
              Hint
            </Badge>
            <span className="text-small text-fg-2">
              <MathText>{entry.hint}</MathText>
            </span>
          </div>
        ) : null}
      </div>
    </li>
  )
}
