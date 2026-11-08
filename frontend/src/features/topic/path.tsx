'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, CaretDown, CaretLeft, CaretRight, Check, CheckCircle, ChatCircleText, Wrench } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useTabPin } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ActivityKind } from '@/lib/learning/next-activity'
import { activityLabel, opensHere } from './activity-copy'
import { useTopic } from './topic-provider'
import { useTopicView } from './use-topic-view'
import { SHORT_LABELS, TOOL_VIEWS, VIEW_LABELS, type PathView, type ToolView } from './types'
import { formatScore } from '@/lib/format'

/** A quiz score under this is "taken, not passed yet": the step is finished, but its mark does not say well done. */
export const QUIZ_LOW_SCORE = 70

/**
 * The marker in front of a step of the path. Colour is never the only signal: a finished step is a check
 * (and says "Completed"), the step to do next is a filled circle (and says "Next up"), the others an outline.
 * A quiz finished under 70% is a check in an outline circle, not the filled accent check of a step done well, and says its score.
 * The number is 12px (the caption size) in a 20px circle, 16px on a phone where five steps share 358px.
 */
export function StepMarker({ number, done, next, lowScore = null }: { number: number; done: boolean; next: boolean; lowScore?: number | null }) {
  if (done && lowScore !== null) {
    return (
      <span role="img" aria-label={`Taken, ${formatScore(lowScore)}`} className="inline-flex size-4 items-center justify-center rounded-full border border-warning text-warning sm:size-5">
        <Check weight="bold" className="size-2.5 sm:size-3" />
      </span>
    )
  }
  if (done) {
    return (
      <span role="img" aria-label="Completed" className="inline-flex size-4 items-center justify-center sm:size-5">
        <CheckCircle weight="fill" className="size-4 text-accent sm:size-5" />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-4 items-center justify-center rounded-full border text-caption font-medium leading-none tabular sm:size-5',
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
    // No "Tools" label beside the links: a word that looks like a menu and does nothing read as a broken control. The group is named for a
    // screen reader, and the rule before it keeps the tools apart from the five steps.
    <div role="group" aria-label="Tools" className="flex items-center gap-0.5 border-l border-border pl-2 max-sm:hidden">
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
 * What to do next on this topic, in the words of the next-activity selector (spec §8.1): its reason and a link, one quiet line.
 * The tag in the path bar is the one next signal; this line says more about it, and only where the open view has no action
 * of its own that leads on (a tool, or the step a next activity that is no step lands on: see `nextLineShows`, which the
 * path bar asks before it draws this). It is left out on the page it points to, and while something is in progress (a quiz being
 * taken, a practice problem under way, a recall being written). Once the activity is finished the line is back with the
 * refreshed next activity (the layout reads it again after every submit), when that is somewhere else.
 */
export function NextActivityCard({ next }: { next: { kind: ActivityKind; reason: string; href: string } }) {
  const pathname = usePathname()
  const search = useSearchParams()
  const { inProgress } = useTopic()
  if (inProgress || next.kind === 'start' || opensHere(next.href, pathname, search)) return null
  // One block on every width: the tag and the reason (two lines at most on a phone), then the way in under it on a phone, beside it on a wide screen.
  return (
    <section aria-label="Next on this topic" className="mt-2 flex flex-col items-start gap-y-0.5 text-small text-fg-2 sm:mt-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 rounded-chip bg-accent-soft px-1.5 text-caption text-accent-soft-fg">{next.kind === 'done_for_now' ? 'For now' : 'Next'}</span>
        <span className="min-w-0 max-sm:line-clamp-2">{next.reason}</span>
      </p>
      <Button asChild variant="link" size="sm" className="shrink-0">
        <Link href={next.href}>
          {activityLabel(next)}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </Button>
    </section>
  )
}

export type PhoneStep = {
  id: PathView
  href: string
  done: boolean
  next: boolean
  /** A short status after the name: "3/8", "82%", "Being written"; null when there is none. */
  status: string | null
  /** A quiz taken under QUIZ_LOW_SCORE: the marker says its score. */
  lowScore: number | null
}

/**
 * The path on a phone: one line, "Step 2 of 5: Read", that opens the five steps in a sheet, instead of a five-tab strip
 * that takes a row of the screen on every step. On a tool (Examples, Explainer, Voice) it names the tool and still opens the
 * steps. The list has the same links, markers and "Next up" signal as the wide screen's path, and is named "Topic path".
 */
export function PhonePath({ steps, view, className }: { steps: PhoneStep[]; view: string; className?: string }) {
  const [open, setOpen] = React.useState(false)
  const at = steps.findIndex((step) => step.id === view)
  const label = at >= 0 ? `Step ${at + 1} of ${steps.length}: ${VIEW_LABELS[steps[at].id]}` : VIEW_LABELS[view as keyof typeof VIEW_LABELS] ?? 'Topic'
  return (
    <div className={cn('border-b border-border', className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-testid="phone-path"
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-control text-left text-body-strong text-fg"
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-small font-normal text-fg-2">
          Steps
          <CaretDown aria-hidden="true" className="size-3.5" />
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Steps in this topic</SheetTitle>
            <SheetDescription>Go in order, or jump to any step.</SheetDescription>
          </SheetHeader>
          <nav aria-label="Topic path" className="overflow-y-auto px-3 py-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <ol className="flex flex-col">
              {steps.map((step, index) => (
                <li key={step.id}>
                  <SheetClose asChild>
                    <Link
                      href={step.href}
                      scroll={false}
                      aria-current={step.id === view ? 'page' : undefined}
                      className="flex min-h-12 items-center gap-3 rounded-control px-2 text-body text-fg hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium"
                    >
                      <StepMarker number={index + 1} done={step.done} next={step.next} lowScore={step.lowScore} />
                      <span className="min-w-0 flex-1 truncate">{VIEW_LABELS[step.id]}</span>
                      {step.status ? <span className="shrink-0 text-small text-fg-2 tabular">{step.status}</span> : null}
                      {step.next ? <NextTag /> : null}
                    </Link>
                  </SheetClose>
                </li>
              ))}
            </ol>
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  )
}
