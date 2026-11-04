'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, BookOpenText, CaretDown, ChatCircleText, ChatText, Microphone, PencilLine, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { SourceLink } from '@/components/learning/source-link'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { MathText } from '@/components/ui/math-text'
import { Card as TeachBackCard } from '@/features/topic/recall-view'
import { linkText } from '@/lib/map/copy'
import { reviewSessionHref } from '@/lib/learning/review-links'
import type { ConceptPanel } from '@/server/queries/map'
import { EdgeQuestion } from './edge-question'
import { FrontierBadge } from './frontier-badge'
import { StateIcon } from './state-icon'

/** What the server worked out in words for this panel: the state line and the evidence lines carry dates in the student's zone. */
export type PanelWords = {
  stateLine: string
  /** "Next up" or "Start here" when the idea is next up, else null. */
  frontier: string | null
  events: { id: string; text: string; when: string }[]
  teachBackPrompt: string
}

/**
 * The node panel (spec §9): the idea, what the pages say about it, where it stands, the last five answers, how it
 * connects (suggested links are asked as "Needs X?" with ✓ and ✗), and the four things to do next. An idea whose last
 * retrieval failed and has not been shown since leads with reading about it (spec 18.5), and says where it was missed.
 */
export function NodePanel({
  courseId,
  panel,
  words,
  closeHref,
  backLabel,
  inSheet = false,
}: {
  courseId: string
  panel: ConceptPanel
  words: PanelWords
  closeHref: string
  /** "Back to the map" or "Back to the list". */
  backLabel: string
  /** Shown in the phone's bottom sheet (map-panel-frame.tsx): "Back" closes the sheet instead of moving focus to the idea. */
  inSheet?: boolean
}) {
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const sectionRef = React.useRef<HTMLElement>(null)
  // Which idea the teach-back card is open for, so choosing another idea closes it.
  const [explainingFor, setExplainingFor] = React.useState<string | null>(null)
  const explaining = explainingFor === panel.id
  // "Other ways to study" is closed until asked for; it stays open while the explain card (one of its actions) is.
  const [othersOpenFor, setOthersOpenFor] = React.useState<string | null>(null)
  const othersOpen = othersOpenFor === panel.id || explaining

  // Choosing an idea (from a node or a list row) shows its panel. Where the panel is already on screen (desktop) focus
  // stays on the node, so moving through the map is not broken; where it is below the fold (a phone) focus and the view
  // move to it. A page opened straight onto an idea (from a topic page) leaves focus alone.
  React.useEffect(() => {
    if (inSheet) return
    const active = document.activeElement
    if (!(active instanceof Element) || !active.closest('[data-node-link]')) return
    const box = sectionRef.current?.getBoundingClientRect()
    if (box && box.top >= 0 && box.top < window.innerHeight * 0.6) return
    headingRef.current?.focus({ preventScroll: true })
    sectionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [panel.id])

  // The card opens at the bottom of a long panel: on a phone it is scrolled up until its button is clear of the tab bar.
  React.useEffect(() => {
    if (!explaining) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    document.getElementById('map-teach-back')?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
  }, [explaining])

  const backToNodes = () => document.querySelector<HTMLElement>('[data-node-link][aria-current="true"]')?.focus()

  const base = `/courses/${courseId}/topics/${panel.topicId}`
  // Read first when the idea is waiting for instruction: the link opens the reader at its first passage and records that it was shown.
  const readFirst = panel.needsInstruction ? (panel.pointer?.href ?? `${base}?view=read&focus=${encodeURIComponent(panel.id)}`) : null
  const stateLine = panel.needsInstruction ? (panel.pointer?.page != null ? `Missed last time: p. ${panel.pointer.page}` : 'Missed last time') : words.stateLine
  const suggested = panel.links.filter((link) => link.status === 'proposed')
  const confirmed = panel.links.filter((link) => link.status === 'confirmed')
  const card = React.useMemo(
    () => ({ key: `tb:${panel.id}`, kind: 'teach_back' as const, objectiveIndex: null, conceptId: panel.id, prompt: words.teachBackPrompt, latest: null }),
    [panel.id, words.teachBackPrompt]
  )

  return (
    <section ref={sectionRef} aria-labelledby="map-panel-heading" data-testid="node-panel" className={inSheet ? 'p-4' : 'scroll-mt-4 rounded-card border border-border bg-surface p-5'}>
      {inSheet ? (
        <Link
          href={closeHref}
          scroll={false}
          className="mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-chip text-small text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {backLabel}
        </Link>
      ) : (
        <button
          type="button"
          onClick={backToNodes}
          className="mb-3 inline-flex min-h-8 items-center rounded-chip text-small text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg max-sm:min-h-11"
        >
          {backLabel}
        </button>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="map-panel-heading" ref={headingRef} tabIndex={-1} className="text-heading text-fg outline-none">
            <MathText>{panel.name}</MathText>
          </h2>
          <p className="mt-0.5 text-small text-fg-3">
            In{' '}
            <Link href={base} className="rounded-chip underline decoration-border-strong underline-offset-[3px] hover:text-fg">
              {panel.topicName}
            </Link>
          </p>
        </div>
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-strong text-fg">
        <StateIcon label={panel.label} size={18} />
        <span>{stateLine}</span>
        {words.frontier ? <FrontierBadge text={words.frontier} /> : null}
      </p>
      {panel.misconception ? (
        <InlineAlert className="mt-3" tone="warning" icon={<WarningCircle />}>
          A wrong idea is on record: {panel.misconception}
        </InlineAlert>
      ) : null}

      <p className="mt-4 text-body text-fg-2">
        <MathText>{panel.summary}</MathText>
      </p>

      {/* One recommended move: read first when the idea is waiting for instruction, else practise it. The other ways in are one tap away. */}
      <div className="mt-5 flex flex-col gap-2">
        {readFirst ? (
          <Button asChild variant="primary" icon={<BookOpenText />}>
            <Link href={readFirst} data-testid="read-first">
              Read about it first
            </Link>
          </Button>
        ) : (
          <Button asChild variant="primary" icon={<PencilLine />}>
            <Link href={reviewSessionHref(courseId, { conceptId: panel.id })} data-testid="practice-this">
              Practice this
            </Link>
          </Button>
        )}
      </div>
      <div className="mt-3">
        <button
          type="button"
          aria-expanded={othersOpen}
          aria-controls="map-other-ways"
          onClick={() => setOthersOpenFor(othersOpenFor === panel.id && !explaining ? null : panel.id)}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-chip text-small text-fg-2 hover:text-fg max-sm:min-h-11"
        >
          Other ways to study
          <CaretDown aria-hidden="true" className={`size-3.5 transition-transform duration-180 ${othersOpen ? 'rotate-180' : ''}`} />
        </button>
        {othersOpen ? (
          <div id="map-other-ways" className="mt-2 flex flex-col gap-2">
            {readFirst ? (
              <Button asChild variant="secondary" icon={<PencilLine />}>
                <Link href={reviewSessionHref(courseId, { conceptId: panel.id })} data-testid="practice-this">
                  Practice this
                </Link>
              </Button>
            ) : null}
            <Button variant="secondary" icon={<ChatText />} aria-expanded={explaining} aria-controls={explaining ? "map-teach-back" : undefined} onClick={() => setExplainingFor(explaining ? null : panel.id)}>
              Explain it
            </Button>
            <Button asChild variant="secondary" icon={<ChatCircleText />}>
              <Link href={`/courses/${courseId}/ask?concept=${encodeURIComponent(panel.id)}`}>Ask about this</Link>
            </Button>
            <Button asChild variant="secondary" icon={<Microphone />}>
              <Link href={`${base}?view=voice&style=teach_back&concept=${encodeURIComponent(panel.id)}`} data-testid="do-it-out-loud">
                Do it out loud
              </Link>
            </Button>
          </div>
        ) : null}
      </div>

      {panel.needsInstruction && panel.explainer ? (
        <p className="mt-2">
          <Link href={panel.explainer.href} className="rounded-chip text-small text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg">
            {panel.explainer.ready ? 'Or read the explanation' : 'Or open the explanation'}
          </Link>
        </p>
      ) : null}

      {explaining ? (
        <div id="map-teach-back" className="mt-5 border-t border-border pt-5">
          <TeachBackCard topicId={panel.topicId} projectId={courseId} card={card} onGraded={() => undefined} />
        </div>
      ) : null}

      {suggested.length > 0 || confirmed.length > 0 ? (
        <div className="mt-6 border-t border-border pt-5">
          <h3 className="text-body-strong text-fg">How it connects</h3>
          {suggested.length > 0 ? (
            <ul aria-label="Suggested links" className="mt-2 flex flex-col gap-2">
              {suggested.map((link) => (
                <li key={link.edgeId}>
                  <EdgeQuestion edgeId={link.edgeId} text={linkText(link.kind, link.otherName, true)} />
                </li>
              ))}
            </ul>
          ) : null}
          {confirmed.length > 0 ? (
            <ul aria-label="Confirmed links" className="mt-2 flex flex-col gap-1 text-body text-fg-2">
              {confirmed.map((link) => (
                <li key={link.edgeId}>{linkText(link.kind, link.otherName, false)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-body-strong text-fg">What your pages say</h3>
        {panel.claims.length === 0 ? (
          <p className="mt-2 text-small text-fg-3">Nothing from your pages is attached to this idea yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {panel.claims.map((claim) => (
              <li key={claim.id} className="text-small text-fg-2">
                <MathText>{claim.text}</MathText>{' '}
                <SourceLink
                  source={{ materialId: claim.materialId, filename: claim.filename, pageStart: claim.pageStart, pageEnd: claim.pageEnd }}
                  className="text-caption text-fg-3"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-body-strong text-fg">Your last answers</h3>
        {words.events.length === 0 ? (
          <p className="mt-2 text-small text-fg-3">No answers on this idea yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {words.events.map((event) => (
              <li key={event.id} className="flex justify-between gap-3 text-small text-fg-2">
                <span>{event.text}</span>
                <span className="shrink-0 text-fg-3">{event.when}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-5">
        <Link href={closeHref} scroll={false} className="rounded-chip text-small text-fg-2 underline decoration-border-strong underline-offset-[3px] hover:text-fg">
          Close the details
        </Link>
      </p>
    </section>
  )
}
