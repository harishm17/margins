'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircleText,
  Clock,
  DotsThree,
  PencilSimple,
  TreeStructure,
  WarningCircle,
} from '@phosphor-icons/react/dist/ssr'
import { PageHeader } from '@/components/shell/slots'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { MathText } from '@/components/ui/math-text'
import { DueLabel } from '@/components/ui/relative-time'
import { toast } from '@/components/ui/toaster'
import { apiFetch, isApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { mapHref } from '@/lib/map/params'
import { fadeNote } from '@/lib/learning/consequence'
import type { TopicStructure } from '@/server/queries/topic'
import { StateIcon } from '@/features/map/state-icon'
import { LABEL_TEXT } from '@/lib/map/copy'
import type { ConceptLabel } from '@/lib/learning/concept-mastery'
import { KIND_COPY } from './copy'
import { RegenerateDialog } from './generation-ui'
import { ToolsMenu } from './path'
import { useTopic } from './topic-provider'
import { TopicStructureBlock, unitLabel } from './topic-structure'
import { useTopicView } from './use-topic-view'
import { CONTENT_KINDS, type ContentKind } from './types'

// The chat client loads the first time the sheet is asked for, so it is not in the topic page's first load.
const loadAskSheet = () => import('@/features/ask/ask-sheet').then((m) => m.AskSheet)
const AskSheet = dynamic(loadAskSheet)

export type TopicNeighbourLink = { id: string; name: string }

/** `label` is the map's word for the idea; `wrongIdea` says a wrong idea is on record for it (the map's panel shows it too). */
export type TopicConceptChip = { id: string; name: string; label: ConceptLabel; wrongIdea: boolean }

type TopicHeaderProps = {
  courseId: string
  topicId: string
  name: string
  description: string | null
  mastery: number | null
  /** A step of the path is done (or a quiz taken): a topic with no mastery yet reads "In progress", not "Not started". */
  started: boolean
  /** Mastery as earned, before it faded for a late review. */
  earnedMastery: number | null
  dueAt: string | null
  /** Days until the review is due, from the server's clock; zero or less means due now. */
  daysUntilDue: number | null
  /** "Next review Thu", worded on the server in the student's own time zone (the one the plan and the review page use). */
  nextReviewText: string | null
  bestQuiz: number | null
  previous: TopicNeighbourLink | null
  next: TopicNeighbourLink | null
  /** Unit, objectives, prerequisites, time and sources. */
  structure: TopicStructure
  /** The topic's concepts and their state, as chips. */
  concepts: TopicConceptChip[]
}

/**
 * "Next review tomorrow", "Next review Thu" within a week, "Next review Oct 29" after that, "Due today" once it
 * is due. The words are the quiz results' (lib/learning/consequence.ts), so both say the same on one screen.
 */
function NextReview({ dueAt, daysUntil, label }: { dueAt: string; daysUntil: number; label: string | null }) {
  if (daysUntil <= 0) return <DueLabel dueAt={dueAt} />
  return <span>{label}</span>
}

/** "3 ideas, 1 solid, 1 wrong idea": the topic's concepts in one line. */
function conceptSummary(concepts: TopicConceptChip[]): string {
  const solid = concepts.filter((concept) => concept.label === 'solid').length
  const wrong = concepts.filter((concept) => concept.wrongIdea).length
  return [
    `${concepts.length} ${concepts.length === 1 ? 'idea' : 'ideas'}`,
    `${solid} solid`,
    ...(wrong > 0 ? [`${wrong} ${wrong === 1 ? 'wrong idea' : 'wrong ideas'}`] : []),
  ].join(', ')
}

/**
 * The topic's concepts and where each stands. State is an icon and the map's words ("Solid", "Shaky"), with "wrong idea" added
 * when one is on record; the colour only repeats them. Nothing shows for a topic without concepts.
 */
function ConceptChips({ concepts, className }: { concepts: TopicConceptChip[]; className?: string }) {
  if (concepts.length === 0) return null
  return (
    <ul aria-label="Ideas in this topic" className={cn('flex flex-wrap gap-1.5', className)}>
      {concepts.map((concept) => (
        <li
          key={concept.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-chip border border-border bg-surface px-2 py-0.5 text-caption text-fg-2"
        >
          {concept.wrongIdea ? <WarningCircle aria-hidden="true" weight="fill" className="size-3.5 text-warning" /> : <StateIcon label={concept.label} size={14} />}
          <span className="min-w-0 break-words text-fg">
            <MathText>{concept.name}</MathText>
          </span>
          <span className="shrink-0 text-fg-3">
            {LABEL_TEXT[concept.label]}
            {concept.wrongIdea ? ', wrong idea' : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function TopicHeader({
  courseId,
  topicId,
  name,
  description,
  mastery,
  started,
  earnedMastery,
  dueAt,
  daysUntilDue,
  nextReviewText,
  bestQuiz,
  previous,
  next,
  structure,
  concepts,
}: TopicHeaderProps) {
  const router = useRouter()
  const view = useTopicView()
  // A quiz being taken is a focus view, like the mock exam's: the tools and the topic arrows are put away until it is done.
  const { keysSuspended: quizTaking } = useTopic()
  // What the topic covers (its description, ideas, objectives, sources and the map link) is behind one button next to the status
  // line, on every width: the title and that line are all that stand between the student and the step's task.
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const aboutId = React.useId()
  const descriptionId = React.useId()
  const fold = !aboutOpen && 'hidden'
  // Why the ring is lower than the last score: mastery fades while a review is late.
  const fade =
    daysUntilDue !== null && daysUntilDue < 0
      ? fadeNote({ earned: earnedMastery, shown: mastery, daysLate: Math.floor(-daysUntilDue) })
      : null
  const go = (target: TopicNeighbourLink | null) => {
    if (target) router.push(`/courses/${courseId}/topics/${target.id}?view=${view}`)
  }
  const wrong = concepts.filter((concept) => concept.wrongIdea).length
  const hasAbout = concepts.length > 0 || structure.objectives.length > 0 || structure.prerequisites.length > 0 || structure.sources.length > 0 || !!description

  return (
    // While an attempt is open on a phone the small attempt bar stands in for this header (see AttemptBar).
    <header className="pb-4 group-data-[attempt]/topic:max-sm:hidden sm:pb-6">
      {structure.unit ? (
        <p className="mb-1 text-small text-fg-3 max-sm:-my-3">
          {/* A standalone link: 44px high on a phone, pulled back by the margin so the header does not grow by that much. */}
          <Link
            href={`/courses/${courseId}/topics`}
            className="rounded-chip underline decoration-border-strong decoration-1 underline-offset-[3px] hover:text-fg max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            {unitLabel(structure.unit)}
          </Link>
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <h1 className="min-w-0 text-title text-fg">{name}</h1>
        {quizTaking ? null : <ToolsMenu courseId={courseId} topicId={topicId} neighbours={{ previous, next }} className="shrink-0" />}
        <div className={cn('flex shrink-0 items-center gap-1 max-sm:hidden', quizTaking && 'hidden')}>
          <IconButton
            label={previous ? `Previous: ${previous.name}` : 'No previous topic'}
            shortcut="["
            icon={<CaretLeft />}
            variant="secondary"
            size="sm"
            disabled={!previous}
            onClick={() => go(previous)}
          />
          <IconButton
            label={next ? `Next: ${next.name}` : 'No next topic'}
            shortcut="]"
            icon={<CaretRight />}
            variant="secondary"
            size="sm"
            disabled={!next}
            onClick={() => go(next)}
          />
        </div>
      </div>
      {description ? (
        <p id={descriptionId} className={cn('mt-1.5 max-w-[68ch] text-body text-fg-2', fold)}>
          <MathText>{description}</MathText>
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-fg-2 sm:mt-3">
        <MasteryIndicator mastery={mastery} showPercent emptyLabel={started ? 'In progress' : undefined} className="text-small" />
        {bestQuiz !== null ? <span className="tabular max-sm:hidden">Best quiz {Math.round(bestQuiz)}%</span> : null}
        {dueAt && daysUntilDue !== null ? <NextReview dueAt={dueAt} daysUntil={daysUntilDue} label={nextReviewText} /> : null}
        {structure.estimatedMinutes ? (
          <span className="inline-flex items-center gap-1.5 tabular">
            <Clock aria-hidden="true" className="size-4 text-fg-3" />
            About {structure.estimatedMinutes} min
          </span>
        ) : null}
        {hasAbout ? (
          <button
            type="button"
            aria-expanded={aboutOpen}
            aria-controls={description ? `${descriptionId} ${aboutId}` : aboutId}
            onClick={() => setAboutOpen((current) => !current)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-chip text-small text-fg-2 hover:text-fg max-sm:min-h-11"
          >
            {wrong > 0 ? <WarningCircle aria-hidden="true" weight="fill" className="size-4 text-warning" /> : null}
            About this topic
            {concepts.length > 0 ? <span className="sr-only">: {conceptSummary(concepts)}</span> : null}
            <CaretDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-180', aboutOpen && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      {fade ? <p className="mt-1.5 text-caption font-normal text-fg-3">{fade}</p> : null}
      <div id={aboutId} className={cn(fold)}>
        <ConceptChips concepts={concepts} className="mt-3" />
        {concepts.length > 0 ? (
          <p className="mt-2 text-small">
            <Link
              href={mapHref(courseId, { unitId: structure.unit?.id ?? null, topicId })}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-chip text-fg-2 underline decoration-border-strong decoration-1 underline-offset-[3px] hover:text-fg max-sm:min-h-11"
            >
              <TreeStructure aria-hidden="true" className="size-4 text-fg-3" />
              Show on the map
            </Link>
          </p>
        ) : null}
        <TopicStructureBlock courseId={courseId} structure={structure} />
      </div>
    </header>
  )
}

function EditTopicDialog({
  topicId,
  name,
  open,
  onOpenChange,
}: {
  topicId: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [value, setValue] = React.useState(name)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const next = value.trim()
    if (!next) {
      setError('Give the topic a name.')
      return
    }
    if (next === name) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await apiFetch(`/api/topics/${topicId}`, { method: 'PATCH', json: { name: next } })
      toast.success('Topic renamed')
      onOpenChange(false)
      router.refresh()
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : "Couldn't rename the topic. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(name)
          setError(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent size="sm">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit topic</DialogTitle>
            <DialogDescription>Rename this topic. Its content and progress stay.</DialogDescription>
          </DialogHeader>
          <Field label="Topic name" error={error}>
            <Input autoComplete="off" maxLength={255} value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The top bar's actions for a topic: "Ask about this" (opens the Ask sheet scoped to the topic)
 * and an overflow menu with regenerate for each kind of content, Ask in full, and rename.
 */
export function TopicActions({ courseId, topicId, name }: { courseId: string; topicId: string; name: string }) {
  const router = useRouter()
  const [regenerate, setRegenerate] = React.useState<ContentKind | null>(null)
  const [editing, setEditing] = React.useState(false)
  // The sheet mounts on first use and stays mounted, so the conversation survives closing it.
  const [askOpen, setAskOpen] = React.useState(false)
  const [askMounted, setAskMounted] = React.useState(false)
  const openAsk = () => {
    setAskMounted(true)
    setAskOpen(true)
  }
  const askHref = `/courses/${courseId}/ask?topic=${topicId}`
  // Not while a quiz is being taken: Ask is help, and the quiz is the attempt (the mock exam's focus view has none either).
  const { keysSuspended: quizTaking } = useTopic()

  return (
    <>
      <PageHeader
        actions={
          quizTaking ? null : (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<ChatCircleText />}
              className="max-sm:hidden"
              onClick={openAsk}
              onPointerEnter={() => void loadAskSheet()}
              onFocus={() => void loadAskSheet()}
            >
              Ask about this
            </Button>
            <IconButton
              label="Ask about this"
              icon={<ChatCircleText />}
              variant="secondary"
              size="sm"
              className="sm:hidden"
              onClick={openAsk}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More actions" icon={<DotsThree weight="bold" />} size="sm" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {CONTENT_KINDS.map((kind) => (
                  <DropdownMenuItem key={kind} onSelect={() => setRegenerate(kind)}>
                    {KIND_COPY[kind].regenerate}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<ChatCircleText />} onSelect={() => router.push(askHref)}>
                  Open in Ask
                </DropdownMenuItem>
                <DropdownMenuItem icon={<PencilSimple />} onSelect={() => setEditing(true)}>
                  Edit topic
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
          )
        }
      />
      {regenerate ? (
        <RegenerateDialog
          key={regenerate}
          kind={regenerate}
          open
          onOpenChange={(open) => {
            if (!open) setRegenerate(null)
          }}
        />
      ) : null}
      {askMounted ? (
        <AskSheet courseId={courseId} topicId={topicId} topicName={name} open={askOpen} onOpenChange={setAskOpen} />
      ) : null}
      <EditTopicDialog topicId={topicId} name={name} open={editing} onOpenChange={setEditing} />
    </>
  )
}
