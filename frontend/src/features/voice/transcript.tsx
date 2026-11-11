'use client'

import * as React from 'react'
import { Lightbulb } from '@phosphor-icons/react/dist/ssr'
import { Badge } from '@/components/ui/badge'
import { MathText } from '@/components/ui/math-text'
import { cn } from '@/lib/utils'
import { speakable } from '@/lib/voice/speakable'
import { cleanForSpeech } from '@/lib/voice/turn-client'
import { splitReading } from './reading'
import { evaluationBadge, type CoachEntry, type TranscriptEntry } from './session-state'

type TranscriptProps = {
  entries: TranscriptEntry[]
  /** What the recognizer has heard so far, not yet sent. */
  interim: string
  /**
   * Tell a screen reader each coach reply once it is complete. Set when the reply is not read aloud by the app: with speech
   * on, the student already hears it, and a second voice reading the same words over it is noise.
   */
  announce?: boolean
  /** The lines from before a reload, shown above the live ones: a short list that never takes the room. */
  earlier?: boolean
  className?: string
}

/** The reply a screen reader is told about: the newest coach turn that is complete, as it would be said. */
function replyToAnnounce(entries: TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.role !== 'coach') continue
    if (entry.streaming) return ''
    const parts = [entry.text.trim(), entry.evaluation ? evaluationBadge(entry.evaluation).label : '', entry.hint ? `Hint: ${entry.hint}` : '']
    return speakable(cleanForSpeech(parts.filter(Boolean).join('. ')))
  }
  return ''
}

/**
 * The conversation so far. About six turns fit; older ones scroll. Coach turns are full
 * strength, the student's are quieter, interim recognition is italic and lighter. On the phone sheet (below md) it takes
 * the room between the board and the answer dock, so the coach's latest turn shows whole (finding 86).
 *
 * The log itself is silent to a screen reader (it can still be read by moving through it): a reply arrives a few words at
 * a time, and a live log would read every piece, on top of the app's own voice. Complete replies go to the quiet region
 * below when `announce` is set. The words being recognised are the student's own, said a moment ago: they are not read back.
 */
export function Transcript({ entries, interim, announce = false, earlier = false, className }: TranscriptProps) {
  const scroller = React.useRef<HTMLDivElement>(null)
  const last = entries[entries.length - 1]
  const lastLength = last && last.role === 'coach' ? last.text.length : 0

  React.useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries.length, lastLength, interim])

  const visible = entries.filter((entry) => entry.role === 'student' || hasContent(entry))

  return (
    <>
    {announce ? (
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="voice-announcer">
        {replyToAnnounce(entries)}
      </div>
    ) : null}
    <div
      ref={scroller}
      role="log"
      aria-label="Conversation"
      aria-live="off"
      data-testid="voice-transcript"
      className={cn('overflow-y-auto py-1 pr-1', earlier ? 'max-h-40 max-md:max-h-24 max-md:shrink-0' : 'min-h-24 md:max-h-[22rem] max-md:min-h-16 max-md:flex-1', className)}
    >
      {visible.length === 0 && !interim ? (
        <p className="py-6 text-center text-small text-fg-3">The conversation shows up here.</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {visible.map((entry) =>
            entry.role === 'student' ? <StudentTurn key={entry.id} text={entry.text} /> : <CoachTurn key={entry.id} entry={entry} />
          )}
          {interim ? (
            <li className="grid grid-cols-[3.25rem_1fr] gap-x-3" aria-hidden="true">
              <span className="pt-0.5 text-caption text-fg-3">You</span>
              <p className="text-body italic text-fg-3" data-testid="voice-interim">
                {interim}
              </p>
            </li>
          ) : null}
        </ol>
      )}
    </div>
    </>
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
  // The question the turn reads out is on the board just above: here it is one line, open on request (finding 86). A screen
  // reader is still told the whole reply (replyToAnnounce), and the app still speaks it.
  const reading = entry.note ? null : splitReading(entry.text, entry.asked, entry.streaming)
  const [shown, setShown] = React.useState(false)
  // Maths and emphasis are drawn once the reply is whole; half a formula is shown as it arrives.
  const said = (text: string) => (entry.streaming ? text : <MathText>{text}</MathText>)
  return (
    <li className="grid grid-cols-[3.25rem_1fr] gap-x-3" data-testid="voice-coach-turn">
      <span className="pt-0.5 text-caption text-fg-3">Coach</span>
      <div className="min-w-0">
        {entry.text.trim() ? (
          <p className={cn('text-body', entry.note ? 'text-fg-2' : 'text-fg')} data-testid={entry.note ? 'voice-coach-note' : undefined}>
            {reading ? (
              <>
                {reading.before ? <>{said(reading.before)} </> : null}
                {shown ? said(reading.reading) : <span className="text-fg-3">The question on the board, read out.</span>}{' '}
                <button
                  type="button"
                  aria-expanded={shown}
                  onClick={() => setShown((value) => !value)}
                  data-testid="voice-reading-toggle"
                  // A 44 px target on a phone without making its line taller: the padding is taken back by the margin.
                  className="rounded-chip text-small font-medium text-accent hover:text-accent-hover max-md:-my-3 max-md:px-1 max-md:py-3"
                >
                  {shown ? 'Hide' : 'Show'}
                </button>
                {reading.after ? <> {said(reading.after)}</> : null}
              </>
            ) : (
              said(entry.text.trim())
            )}
            {entry.streaming ? (
              <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-caret bg-fg-3" />
            ) : null}
            {entry.interrupted ? <span className="text-fg-3">{' '}(interrupted)</span> : null}
          </p>
        ) : null}
        {/* The verdict is said once: the coach's words above, and this mark. The grader's note to the coach is not shown;
            it said the same thing a second time, and for a wrong answer it gave the answer the coach holds back (finding 69). */}
        {entry.evaluation && badge ? (
          <div className="mt-1.5 flex" data-testid="voice-evaluation">
            <Badge tone={badge.tone}>{badge.label}</Badge>
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
