'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, CaretDown, CaretLeft, CaretRight, CheckCircle, ChatCircleText, Wrench } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTabPin } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { activityVerb, opensHere } from './activity-copy'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { SHORT_LABELS, TOOL_VIEWS, VIEW_LABELS, type ToolView } from './types'

/**
 * The marker in front of a step of the path. Colour is never the only signal: a finished step is a check
 * (and says "Completed"), the step to do next is a filled circle (and says "Next up"), the others an outline.
 */
export function StepMarker({ number, done, next }: { number: number; done: boolean; next: boolean }) {
  if (done) {
    return (
      <span role="img" aria-label="Completed" className="inline-flex size-4 items-center justify-center">
        <CheckCircle weight="fill" className="size-4 text-accent" />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-4 items-center justify-center rounded-full border text-[10px] font-medium leading-none tabular',
        next ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong text-fg-3'
      )}
    >
      {number}
    </span>
  )
}

/** "Next" after the step the next activity belongs to: a word on a wide screen, a word for screen readers on a phone. */
export function NextTag() {
  return (
    <>
      <span className="sr-only"> (next up)</span>
      <span aria-hidden="true" className="rounded-chip bg-accent-soft px-1.5 text-caption text-accent-soft-fg max-sm:hidden">
        Next
      </span>
    </>
  )
}

/** The text part of a step's status (a count, a score): shown on a wide screen, read out on a phone. */
export function StepStatus({ children }: { children: React.ReactNode }) {
  return <span className="tabular max-sm:sr-only">{children}</span>
}

type ToolsProps = {
  courseId: string
  topicId: string
  className?: string
  /** The topics before and after this one: on a phone their arrows are in this menu, not in the header. */
  neighbours?: { previous: { id: string; name: string } | null; next: { id: string; name: string } | null }
}

const toolHref = (props: ToolsProps, view: ToolView) => `/courses/${props.courseId}/topics/${props.topicId}?view=${view}`

/** The tools beside the path on a wide screen: Examples, Explainer, Voice. Ask is the button in the header. */
export function ToolLinks(props: ToolsProps) {
  const view = useTopicView()
  const pin = useTabPin()
  return (
    <div role="group" aria-label="Tools" className="flex items-center gap-0.5 max-sm:hidden">
      <span aria-hidden="true" className="mr-1 flex items-center gap-1 border-r border-border pr-2.5 text-caption font-medium text-fg-3">
        <Wrench className="size-3.5" />
        Tools
      </span>
      {TOOL_VIEWS.map((id) => (
        <Link
          key={id}
          href={toolHref(props, id)}
          scroll={false}
          onClick={(event) => pin(event, id)}
          aria-current={view === id ? 'page' : undefined}
          className="inline-flex h-8 items-center rounded-control px-2.5 text-small text-fg-2 transition-colors duration-120 hover:bg-surface-2 hover:text-fg aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium aria-[current=page]:text-fg"
        >
          {SHORT_LABELS[id]}
        </Link>
      ))}
    </div>
  )
}

/** On a phone the tools sit in one menu under the path. */
export function ToolsMenu(props: ToolsProps) {
  const router = useRouter()
  const view = useTopicView()
  const current = TOOL_VIEWS.find((id) => id === view)
  return (
    <div className={cn('sm:hidden', props.className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" icon={<Wrench />}>
            <span className="inline-flex items-center gap-1">
              {current ? `Tools: ${SHORT_LABELS[current]}` : 'Tools'}
              <CaretDown className="size-3.5" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {TOOL_VIEWS.map((id) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => router.push(toolHref(props, id), { scroll: false })}
              aria-current={view === id ? 'page' : undefined}
              trailing={view === id ? <CheckCircle aria-hidden="true" weight="fill" className="size-4 text-accent" /> : undefined}
            >
              {VIEW_LABELS[id]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem icon={<ChatCircleText />} onSelect={() => router.push(`/courses/${props.courseId}/ask?topic=${props.topicId}`)}>
            Ask about this topic
          </DropdownMenuItem>
          {[
            { target: props.neighbours?.previous, label: 'Previous topic', icon: <CaretLeft /> },
            { target: props.neighbours?.next, label: 'Next topic', icon: <CaretRight /> },
          ].map(({ target, label, icon }) =>
            target ? (
              <DropdownMenuItem key={label} icon={icon} onSelect={() => router.push(`/courses/${props.courseId}/topics/${target.id}?view=${view}`)}>
                {label}: {target.name}
              </DropdownMenuItem>
            ) : null
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * What to do next on this topic, in the words of the next-activity selector (spec §8.1): its reason and a link.
 * It is one quiet line, never a button above the step's own primary action, and there is one per topic with one
 * piece of advice, the same on every step for the same state (it comes from the state, not from the view).
 *
 * `settled` is whether the student is on a step that is finished or not offered, or on a tool: only then does the
 * line show, because a student who chose a step on purpose is doing it, and a line that sends them elsewhere pulls
 * them off it. It is also left out on the step it points to (the activity is already on screen), while something is
 * in progress (a quiz being taken, a practice problem under way, a warm-up or recall being written), and for a topic
 * nobody has opened (the page is the way in). Once the activity is finished the line is back with the refreshed
 * next activity (the layout reads it again after every submit), when that is somewhere else.
 */
export function NextActivityCard({ next, settled }: { next: { kind: ActivityKind; reason: string; href: string }; settled: boolean }) {
  const pathname = usePathname()
  const search = useSearchParams()
  const { inProgress } = useTopic()
  // On a phone the reason is behind "Why" so the line is short: the tag, the way on, and the question.
  const [whyOpen, setWhyOpen] = React.useState(false)
  const reasonId = React.useId()
  if (!settled || inProgress || next.kind === 'start' || opensHere(next.href, pathname, search)) return null
  return (
    <section aria-label="Next on this topic" className="mt-2 flex items-center justify-between gap-x-3 gap-y-0.5 text-small text-fg-2 sm:mt-3 sm:flex-wrap sm:justify-start sm:items-baseline">
      <p className="flex min-w-0 flex-1 items-baseline gap-2 sm:flex-none">
        <span className="shrink-0 rounded-chip bg-accent-soft px-1.5 text-caption text-accent-soft-fg">{next.kind === 'done_for_now' ? 'For now' : 'Next'}</span>
        <span id={reasonId} className={cn('min-w-0', !whyOpen && 'max-sm:hidden')}>
          {next.reason}
        </span>
        <button
          type="button"
          aria-expanded={whyOpen}
          aria-controls={reasonId}
          onClick={() => setWhyOpen((current) => !current)}
          className="inline-flex min-h-11 shrink-0 items-center gap-0.5 self-center rounded-chip text-small text-fg-2 hover:text-fg sm:hidden"
        >
          Why
          <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', whyOpen && 'rotate-180')} />
        </button>
      </p>
      <Button asChild variant="link" size="sm" className="shrink-0">
        <Link href={next.href}>
          {activityVerb(next.kind)}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </Button>
    </section>
  )
}
