'use client'

import * as React from 'react'
import { GradeSaved, gradeLabel, SelfGradeRow } from '@/components/learning/self-grade'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyMarkdown } from '@/components/ui/lazy-markdown'
import { Textarea } from '@/components/ui/textarea'
import { ConfidenceRow } from '@/features/topic/quiz-confidence'
import { apiFetch, isApiError } from '@/lib/api/client'
import { useFocusRequest } from '@/lib/hooks/use-focus'
import type { CheckView } from '@/lib/ask/tutor-message'
import type { ConfidenceId } from '@/lib/learning/calibration'
import type { CheckGrade } from '@/lib/reader/checks'


type Revealed = { answer: string; explanation: string }
type Settled = { grade: CheckGrade; counted: boolean }

type CheckCardProps = {
  messageId: string
  check: CheckView
  /** The newest reply's card: shown whole as soon as it appears, not left under the edge of the messages. */
  bringIntoView?: boolean
}

/**
 * The question that ends an explanation (spec 6.3), set under the reply with a hairline above it. The student
 * answers from memory and says how sure they are (optional), asks to see the answer, and grades themselves: Got
 * it, Partly or Missed. That is level 2, graded by the student, for display. The answer is fetched when it is
 * asked for, together with the student's attempt: the server returns it only after it holds one.
 */
export function CheckCard({ messageId, check, bringIntoView = false }: CheckCardProps) {
  const [answer, setAnswer] = React.useState('')
  const [dontKnow, setDontKnow] = React.useState(false)
  const [level, setLevel] = React.useState<ConfidenceId | undefined>(undefined)
  const [revealed, setRevealed] = React.useState<Revealed | null>(null)
  const [settled, setSettled] = React.useState<Settled | null>(check.grade ? { grade: check.grade, counted: true } : null)
  const [busy, setBusy] = React.useState<'reveal' | 'grade' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const headingId = React.useId()
  const cardRef = React.useRef<HTMLDivElement>(null)
  const mounted = React.useRef(false)
  // Read once, at the first run: whether this was the newest reply's card when it appeared. A later reply must not
  // bring this older card back into view, so it is not a dependency of the effect below.
  const bringOnMount = React.useRef(bringIntoView)

  // When the answer is shown or the grade is saved the card grows: bring it fully into view above the composer
  // (on a phone the composer and the tab bar leave little room).
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      // The messages scroll above the composer, so a card that ends below their edge (its confidence row, its buttons) is
      // scrolled up until it ends above the composer. Later cards of an opened conversation are left where they are.
      if (!bringOnMount.current || settled) return
    }
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
  }, [revealed, settled])
  const whyId = React.useId()
  const focus = useFocusRequest()

  async function reveal(unknown: boolean) {
    if (busy) return
    setBusy('reveal')
    setError(null)
    try {
      const found = await apiFetch<Revealed>('/api/ask-checks/reveal', {
        method: 'POST',
        json: { messageId, ...(unknown ? { idk: true } : { attempt: answer.trim() }) },
      })
      setDontKnow(unknown)
      setRevealed(found)
      // The buttons that were pressed are gone: focus goes to the answer that took their place.
      focus.request('answer')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not load the answer. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function grade(value: CheckGrade) {
    if (busy) return
    setBusy('grade')
    setError(null)
    try {
      const result = await apiFetch<{ recorded?: boolean; grade?: CheckGrade }>('/api/ask-checks', {
        method: 'POST',
        json: { messageId, grade: value, ...(level ? { confidenceLevel: level } : {}), ...(dontKnow ? { idk: true } : {}) },
      })
      setSettled({ grade: result.grade ?? value, counted: result.recorded !== false })
      focus.request('saved')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save your answer. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const ready = answer.trim().length > 0

  return (
    <div ref={cardRef} role="group" aria-labelledby={headingId} className="mt-6 max-w-[680px] scroll-mb-6 border-t border-border pt-3" data-ask-check="">
      <h2 id={headingId} className="text-caption text-fg-3">
        Check yourself
      </h2>
      <p className="mt-0.5 text-body-strong text-fg">{check.question}</p>

      {settled ? (
        <GradeSaved ref={focus.register('saved')}>
          {settled.counted ? `Saved: ${gradeLabel(settled.grade)}` : `Graded: ${gradeLabel(settled.grade)}. It is not added to your progress.`}
        </GradeSaved>
      ) : revealed ? (
        <>
          <div ref={focus.register('answer')} tabIndex={-1} className="mt-2 border-l-2 border-border pl-3 outline-none">
            <p className="text-caption text-fg-3">Your answer</p>
            <p className="whitespace-pre-wrap break-words text-small text-fg">{dontKnow && !answer.trim() ? "I don't know" : answer}</p>
            <p className="mt-2 text-caption text-fg-3">The answer</p>
            <p className="break-words text-body text-fg">{revealed.answer}</p>
            {revealed.explanation ? (
              <LazyMarkdown variant="reading" className="mt-1 !text-[14px] !leading-[22px]">
                {revealed.explanation}
              </LazyMarkdown>
            ) : null}
          </div>
          <SelfGradeRow disabled={busy === 'grade'} onGrade={(value) => void grade(value)} />
        </>
      ) : (
        <>
          <Textarea
            className="mt-2"
            rows={1}
            maxRows={5}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            aria-label={`Your answer: ${check.question}`}
            placeholder="Answer from memory"
            maxLength={2000}
          />
          <div className="[&_[data-confidence-row]]:mt-4">
            <ConfidenceRow value={undefined} level={level} onChange={(next) => setLevel(next)} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={!ready}
              aria-describedby={ready ? undefined : whyId}
              loading={busy === 'reveal'}
              onClick={() => void reveal(false)}
            >
              Show the answer
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === 'reveal'} onClick={() => void reveal(true)}>
              I don&apos;t know
            </Button>
          </div>
          {ready ? null : (
            <p id={whyId} className="mt-1.5 text-caption text-fg-3">
              Write an answer first, or tap &quot;I don&apos;t know&quot;.
            </p>
          )}
        </>
      )}
      {error ? (
        <InlineAlert className="mt-2" tone="danger">
          {error}
        </InlineAlert>
      ) : null}
    </div>
  )
}
