'use client'

import * as React from 'react'
import { GradeSaved, gradeLabel, SelfGradeRow } from '@/components/learning/self-grade'
import { SourceLink } from '@/components/learning/source-link'
import { Button } from '@/components/ui/button'
import { LazyMarkdownInline } from '@/components/ui/lazy-markdown'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, isApiError } from '@/lib/api/client'
import { focusElement, nextFocusableAfter, useFocusRequest } from '@/lib/hooks/use-focus'
import { quoteOnOneLine } from '@/lib/chat/citations'
import type { CheckGrade } from '@/lib/reader/checks'
import type { ReaderCheckView } from '@/lib/reader/load-reader'
import { parseSettled, type Settled } from './reader-settled'
import { useOptionalTopic } from './topic-provider'
import { statusLabel, useServerDraft } from '@/features/learning/use-server-draft'

const storageKey = (claimId: string) => `reader-check:${claimId}`

const noSubscribe = () => () => {}

function useStoredSettled(claimId: string): Settled | null {
  const raw = React.useSyncExternalStore(
    noSubscribe,
    () => {
      try {
        return window.sessionStorage.getItem(storageKey(claimId))
      } catch {
        return null
      }
    },
    () => null
  )
  return React.useMemo(() => parseSettled(raw), [raw])
}

/** What the server keeps of a check being answered (spec 18.7): the text, and whether the source was already shown. */
type CheckDraft = { answer: string; revealed: boolean }

const parseCheckDraft = (raw: unknown): CheckDraft | null => {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  return typeof value.answer === 'string' ? { answer: value.answer, revealed: value.revealed === true } : null
}

function writeSettled(claimId: string, value: Settled) {
  try {
    window.sessionStorage.setItem(storageKey(claimId), JSON.stringify(value))
  } catch {
    // Storage may be unavailable (private mode): the check just shows again after a reload.
  }
}

type Source = { quote: string; pageStart: number | null }

/**
 * "Before you go on": one short question after a section that holds a claim, set into the reading with a
 * hairline above it rather than boxed. The student types an answer, or says they don't know, then asks to see the
 * sentence in their file (fetched then, not sent with the page) and grades themselves: Got it, Partly or Missed
 * (level 2, self-graded, spec §5.2). It can be skipped, and there is never more than one per section.
 */
export function ReaderCheck({ topicId, check, filename, materialId, pdf }: { topicId: string; check: ReaderCheckView; filename: string; materialId: string; pdf: boolean }) {
  const stored = useStoredSettled(check.claimId)
  const [chosen, setSettled] = React.useState<Settled | null>(null)
  // What the student did in this browser session, else what the server has of their grade (a new session, another device).
  const settled: Settled | null = chosen ?? stored ?? (check.graded ? { state: 'done', grade: check.graded, counted: true } : null)
  // The answer being written lives on the server (spec 18.7): it survives a reload, a closed tab and another device.
  const projectId = useOptionalTopic()?.courseId ?? null
  const draft = useServerDraft<CheckDraft>('reader_check', check.claimId, { projectId, topicId, parse: parseCheckDraft })
  // What was typed since the page showed; until then, the saved draft.
  const [typedAnswer, setTypedAnswer] = React.useState<string | null>(null)
  const answer = typedAnswer ?? draft.value?.answer ?? ''
  const setAnswer = (value: string) => {
    setTypedAnswer(value)
    if (value) draft.set({ answer: value, revealed: false })
    else void draft.clear()
  }
  const [dontKnow, setDontKnow] = React.useState(false)
  const [source, setSource] = React.useState<Source | null>(null)
  const [busy, setBusy] = React.useState<'reveal' | 'grade' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const headingId = `check-${check.claimId}`
  const whyId = React.useId()
  const groupRef = React.useRef<HTMLDivElement>(null)
  const focus = useFocusRequest()

  async function reveal(unknown: boolean) {
    if (busy) return
    setBusy('reveal')
    setError(null)
    try {
      const found = await apiFetch<Source>(`/api/topics/${topicId}/reader-checks?claimId=${encodeURIComponent(check.claimId)}`)
      setDontKnow(unknown)
      setSource(found)
      // A reload shows the source again where it was; the answer stays saved until it is graded.
      draft.set({ answer: typedAnswer ?? draft.value?.answer ?? '', revealed: true })
      // The buttons that were pressed are gone: focus goes to the source that took their place.
      focus.request('source')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not load the source. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function grade(value: CheckGrade) {
    if (busy) return
    setBusy('grade')
    setError(null)
    try {
      const result = await apiFetch<{ recorded?: boolean }>(`/api/topics/${topicId}/reader-checks`, { method: 'POST', json: { claimId: check.claimId, grade: value } })
      const next: Settled = { state: 'done', grade: value, counted: result.recorded !== false }
      writeSettled(check.claimId, next)
      await draft.clear()
      setSettled(next)
      focus.request('saved')
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Could not save your answer. Try again.')
    } finally {
      setBusy(null)
    }
  }

  function skip() {
    // The check leaves the page: focus goes on to what follows it.
    const after = groupRef.current ? nextFocusableAfter(groupRef.current) : null
    const next: Settled = { state: 'skipped' }
    writeSettled(check.claimId, next)
    void draft.clear()
    setSettled(next)
    focusElement(after)
  }

  // The source was shown before the reload: show it again, without taking focus.
  const restore = draft.value?.revealed === true && !settled && !source
  const savedAnswer = draft.value?.answer ?? ''
  React.useEffect(() => {
    if (!restore) return
    let cancelled = false
    apiFetch<Source>(`/api/topics/${topicId}/reader-checks?claimId=${encodeURIComponent(check.claimId)}`)
      .then((found) => {
        if (cancelled) return
        setDontKnow(!savedAnswer.trim())
        setSource(found)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [restore, topicId, check.claimId, savedAnswer])

  if (settled?.state === 'skipped') return null
  const ready = answer.trim().length > 0

  return (
    <div ref={groupRef} role="group" aria-labelledby={headingId} className="my-7 max-w-[680px] border-t border-border pt-3" data-check="">
      <h3 id={headingId} className="text-caption text-fg-3">
        Before you go on
      </h3>
      <p className="mt-0.5 text-body-strong text-fg">{check.question}</p>

      {settled?.state === 'done' ? (
        <GradeSaved ref={focus.register('saved')}>
          {settled.counted ? `Saved: ${gradeLabel(settled.grade)}` : `You graded this one before, so ${gradeLabel(settled.grade)} is not counted again.`}
        </GradeSaved>
      ) : (
        <>
          {source ? (
            <>
              <div ref={focus.register('source')} tabIndex={-1} className="mt-2 border-l-2 border-border pl-3 outline-none">
                <p className="text-caption text-fg-3">Your answer</p>
                <p className="whitespace-pre-wrap break-words text-small text-fg">{dontKnow && !answer.trim() ? "I don't know" : answer}</p>
                <p className="mt-2 text-caption text-fg-3">
                  In your file
                  {source.pageStart !== null ? (
                    <>
                      , <SourceLink source={{ materialId, filename, pageStart: pdf ? source.pageStart : null, pageEnd: null }} className="text-caption" />
                    </>
                  ) : null}
                </p>
                <p className="break-words text-small text-fg" data-source-quote="">
                  <LazyMarkdownInline>{quoteOnOneLine(source.quote)}</LazyMarkdownInline>
                </p>
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
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!ready}
                  aria-describedby={ready ? undefined : whyId}
                  loading={busy === 'reveal'}
                  onClick={() => void reveal(false)}
                >
                  Show the source
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === 'reveal'} onClick={() => void reveal(true)}>
                  I don&apos;t know
                </Button>
                <Button size="sm" variant="ghost" className="text-fg-2" onClick={skip}>
                  Skip
                </Button>
              </div>
              {statusLabel(draft.status) && ready ? <p className="mt-1.5 text-caption text-fg-3">{statusLabel(draft.status)}</p> : null}
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
        </>
      )}
    </div>
  )
}
