'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react/dist/ssr'
import { SourceLink } from '@/components/learning/source-link'
import { AiBlockedNote, useAiStatus } from '@/features/ai/ai-status'
import { Button } from '@/components/ui/button'
import { CheckGradeContext, ExplainerDraftContext } from '@/components/ui/check-context'
import { InlineAlert } from '@/components/ui/inline-alert'
import { LazyCheckYourself, LazyMarkdown } from '@/components/ui/lazy-markdown'
import { apiFetch, isApiError } from '@/lib/api/client'
import { isPdf } from '@/lib/chat/citations'
import type { GapExplainerState, GapSource } from '@/lib/learning/explainer-server'
import { Spinner } from '@/components/ui/spinner'
import { usePolling } from '@/lib/hooks/use-polling'
import { useOptionalTopic } from './topic-provider'
import { useCheckGrader } from './use-check-grader'
import { scrollToElement, useSeenInView } from './use-seen-in-view'

/** How long the page keeps asking whether the explanations are written (about three minutes). */
const POLL_MS = 4000
const MAX_POLLS = 45

const sourceRef = (source: GapSource) => ({
  materialId: source.materialId,
  filename: source.filename,
  pageStart: isPdf(source.filename) ? source.page : null,
  pageEnd: null,
})

/**
 * While the explanations are being written the page asks again, so they appear without a reload. After a few minutes
 * it stops asking, and `waitedOut` is true until the student chooses to check again.
 */
function useRefreshWhile(active: boolean): { waitedOut: boolean; checkAgain: () => void } {
  const router = useRouter()
  const { waitedOut, again } = usePolling(() => React.startTransition(() => router.refresh()), {
    active,
    intervalMs: POLL_MS,
    maxPolls: MAX_POLLS,
  })
  const checkAgain = React.useCallback(() => {
    again()
    React.startTransition(() => router.refresh())
  }, [again, router])
  return { waitedOut, checkAgain }
}

function WriteAgain({ topicId }: { topicId: string }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { blocked, report } = useAiStatus()
  async function start() {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/topics/${topicId}/explainer`, { method: 'POST', json: { action: 'write' } })
      React.startTransition(() => router.refresh())
    } catch (caught) {
      if (isApiError(caught)) report(caught.code)
      setError(isApiError(caught) ? caught.message : 'Could not start that. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" variant="secondary" loading={busy} disabled={!!blocked} onClick={() => void start()}>
        Write them again
      </Button>
      <AiBlockedNote />
      {error ? (
        <InlineAlert tone="danger" className="max-w-[560px]">
          {error}
        </InlineAlert>
      ) : null}
    </div>
  )
}

/**
 * The gap form of the explainer (spec §5.4): for each idea the recall left out or got wrong, a short explanation from
 * the student's own pages and one question to check it. Ideas that could not be explained are listed with their page.
 * The explanations are written in the background after a recall answer; until then the page says so and checks again.
 */
export function GapExplainer({
  topicId,
  state,
  nextHref,
  nextLabel,
  focusConceptId = null,
}: {
  topicId: string
  state: GapExplainerState
  nextHref: string
  nextLabel: string
  /** The idea the student came here for (a pointer, the next activity): the page scrolls to it. */
  focusConceptId?: string | null
}) {
  const saveGrade = useCheckGrader(topicId)
  const projectId = useOptionalTopic()?.courseId ?? null
  const { waitedOut, checkAgain } = useRefreshWhile(state.status === 'pending')
  const hasGaps = state.gaps.length > 0
  // One idea at a time. The questions the student has tried (a grade of their own, or "I don't know") unlock the way on at the end.
  const [index, setIndex] = React.useState(0)
  const [tried, setTried] = React.useState<ReadonlySet<string>>(() => new Set())
  const grade = React.useCallback<typeof saveGrade>(
    async (input) => {
      const result = await saveGrade(input)
      setTried((current) => new Set(current).add(input.question))
      return result
    },
    [saveGrade]
  )
  // The first time the explanations are on screen, they are recorded as help the AI gave (level 3), once per attempt.
  React.useEffect(() => {
    if (hasGaps) void apiFetch(`/api/topics/${topicId}/explainer`, { method: 'POST', json: { action: 'gaps_shown' } }).catch(() => undefined)
  }, [topicId, hasGaps, state.gaps.length])
  const listRef = React.useRef<HTMLOListElement>(null)
  // Reading a section is instruction on its idea (spec 18.5): once per idea per day, recorded when it is on screen.
  useSeenInView(
    () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-concept-id]') ?? [])].map((element) => ({ key: element.dataset.conceptId as string, element, payload: element.dataset.conceptId as string })),
    (conceptId) => void apiFetch(`/api/topics/${topicId}/explainer`, { method: 'POST', json: { action: 'section_viewed', kind: 'gap_explainer', conceptIds: [conceptId] } }).catch(() => undefined),
    { watch: listRef, deps: [state.gaps.length, index] }
  )
  // Coming for one idea: the page opens at its explanation. Once, when the gaps are there.
  const opened = React.useRef(false)
  React.useEffect(() => {
    if (!focusConceptId || opened.current) return
    const at = state.gaps.findIndex((gap) => gap.conceptId === focusConceptId)
    if (at < 0) return
    opened.current = true
    setIndex(at)
  }, [focusConceptId, state.gaps])
  // Two gaps under one concept get "part 1 of 2" so their headings differ.
  const parts = new Map<string, number>()
  const partOf = new Map<string, number>()
  for (const gap of state.gaps) {
    parts.set(gap.conceptName, (parts.get(gap.conceptName) ?? 0) + 1)
    partOf.set(gap.claimId, parts.get(gap.conceptName) ?? 1)
  }
  const gapCount = state.gaps.length
  const current = Math.min(index, Math.max(0, gapCount - 1))
  const last = current >= gapCount - 1
  const allTried = hasGaps && state.gaps.every((gap) => tried.has(gap.check.question))
  const untried = hasGaps ? state.gaps.filter((gap) => !tried.has(gap.check.question)).length : 0
  const go = (to: number) => {
    setIndex(to)
    // The next idea starts at its top, not wherever the last one was scrolled to.
    requestAnimationFrame(() => {
      const heading = listRef.current
      if (heading) scrollToElement(heading)
    })
  }

  return (
    <CheckGradeContext.Provider value={grade}>
      <div className="max-w-[720px]">
        <p className="text-small text-fg-2">
          These are the ideas your recall left out or got wrong, explained from your own pages. Try each question before you look at its answer.
        </p>

        {state.status === 'pending' && !waitedOut ? (
          <InlineAlert className="mt-4" icon={<Spinner />}>
            Writing short explanations of what you missed. This takes a minute.
          </InlineAlert>
        ) : null}
        {state.status === 'pending' && waitedOut ? (
          <InlineAlert tone="warning" className="mt-4" title="This is taking longer than expected">
            <div className="flex flex-col items-start gap-2">
              <span>The explanations are still being written. You can check again, or open the full explainer.</span>
              <Button size="sm" variant="secondary" onClick={checkAgain}>
                Check again
              </Button>
            </div>
          </InlineAlert>
        ) : null}
        {state.status === 'failed' ? (
          <InlineAlert tone="warning" className="mt-4" title="The explanations haven't been written">
            <div className="flex flex-col gap-2">
              <span>Your recall is saved. You can write the explanations now, or open the full explainer.</span>
              <WriteAgain topicId={topicId} />
            </div>
          </InlineAlert>
        ) : null}

        {hasGaps ? (
          <p aria-live="polite" data-testid="gap-counter" className="tabular mt-6 text-small text-fg-2">
            Idea {current + 1} of {gapCount}
          </p>
        ) : null}
        <ol ref={listRef} className="mt-2 flex flex-col gap-10" aria-label="Ideas to look at again">
          {state.gaps.slice(current, current + 1).map((gap) => {
            const total = parts.get(gap.conceptName) ?? 1
            const part = partOf.get(gap.claimId) ?? 1
            return (
            <li key={gap.claimId} aria-labelledby={`gap-${gap.claimId}`} data-concept-id={gap.conceptId || undefined} className="scroll-mt-[140px]">
              <h2 id={`gap-${gap.claimId}`} className="text-subheading text-fg">
                {total > 1 ? `${gap.conceptName}, part ${part} of ${total}` : gap.conceptName}
              </h2>
              <div className="mt-2">
                <LazyMarkdown variant="reading">{gap.explanation}</LazyMarkdown>
              </div>
              <p className="mt-2 text-small text-fg-3">
                In your pages: <SourceLink source={sourceRef(gap.source)} />
              </p>
              <div className="mt-4">
                <ExplainerDraftContext.Provider value={{ projectId, topicId, scope: `gap-${gap.claimId}` }}>
                <LazyCheckYourself question={gap.check.question} answer={gap.check.answer} conceptId={gap.conceptId || null} />
                </ExplainerDraftContext.Provider>
              </div>
            </li>
            )
          })}
        </ol>

        {hasGaps ? (
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="ghost" icon={<ArrowLeft />} disabled={current === 0} onClick={() => go(current - 1)}>
              Previous idea
            </Button>
            {last ? null : (
              <Button variant="secondary" onClick={() => go(current + 1)} data-testid="gap-next">
                <span className="inline-flex items-center gap-1.5">
                  Next idea
                  <ArrowRight aria-hidden="true" className="size-4" />
                </span>
              </Button>
            )}
          </div>
        ) : null}

        {state.skipped.length > 0 && (last || !hasGaps) ? (
          <section aria-labelledby="gap-skipped" className="mt-10 border-t border-border pt-6">
            <h2 id="gap-skipped" className="text-body-strong text-fg">
              Look at these in your pages
            </h2>
            <p className="mt-1 text-small text-fg-2">These could not be explained from what your pages say, so read them there.</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-small text-fg-2">
              {state.skipped.map((item) => (
                <li key={item.claimId}>
                  {item.conceptName ? `${item.conceptName}: ` : null}
                  <SourceLink source={sourceRef(item.source)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* The way on is one button, and only on the last idea. It is the primary once every question has been tried; before that it is a
            quiet link, so a student who comes back to the page later (their grades are saved, this page's count starts again) is never stuck. */}
        {last || !hasGaps ? (
          <div className="mt-10 border-t border-border pt-6">
            {hasGaps && !allTried ? (
              <p className="mb-3 text-small text-fg-2" data-testid="gap-untried">
                {untried === 1 ? '1 question left to try' : `${untried} questions left to try`} before you go on.
              </p>
            ) : null}
            <Button asChild variant={allTried || !hasGaps ? 'primary' : 'link'}>
              <Link href={nextHref} scroll={false} data-testid="gap-onward">
                {allTried || !hasGaps ? nextLabel : nextLabel.replace(/^Next: /, 'Skip to ')}
                <ArrowRight aria-hidden="true" className="ml-1 size-4" />
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    </CheckGradeContext.Provider>
  )
}
