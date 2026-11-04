'use client'

import * as React from 'react'
import Link from 'next/link'
import { CaretDown, PencilSimple } from '@phosphor-icons/react/dist/ssr'
import { PageIntro } from '@/components/shell/page'
import { StatusGuide } from '@/components/learning/status-guide'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { ProgressRing } from '@/components/ui/progress-ring'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { MathText } from '@/components/ui/math-text'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { pluralize } from '@/lib/format'
import { masteryLabel, masteryLevel, masteryPercent, masteryTone } from '@/lib/mastery'
import { groupTopicsByUnit, unitMastery, type UnitGroup as UnitGroupOf } from '@/lib/topics/units'
import { cn } from '@/lib/utils'
import type { GenerationState, TopicsData } from '@/server/queries/course'
import { BuildingContent } from './building-content'
import type { PathGlyph, PathGlyphState } from '@/features/topic/path-steps'
import { needsWorkOrder } from './summary'

export type ListTopic = {
  id: string
  name: string
  description: string | null
  orderIndex: number
  /** The unit it belongs to, or null (a flat course, or a topic added by hand). */
  unitId: string | null
  /** On the student's past exams: shows a small tag. */
  examRelevant: boolean
  mastery: number | null
  dueAt: string | null
  /** "Due today" or "Next review in 4 days", worked out on the server. */
  timing: { due: boolean; text: string } | null
  /** The steps this topic offers (the topic page's own list), each done, next or later, and what is next in words. */
  path: { glyphs: PathGlyph[]; nextWords: string; quizScore: number | null }
}

const SEGMENT: Record<PathGlyphState, string> = {
  done: 'bg-accent',
  next: 'bg-accent-soft ring-1 ring-inset ring-accent',
  later: 'bg-surface-3 ring-1 ring-inset ring-control',
}

/**
 * How far the topic has come, for the row's detail: one segment per step of its path and the count in words, with the quiz score
 * and mastery. The segments are for the eye (each has an edge, so an empty one is still a shape); the words carry the meaning.
 */
function PathStatus({ path, percent }: { path: ListTopic['path']; percent: number | null }) {
  const done = path.glyphs.filter((glyph) => glyph.state === 'done').length
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap text-caption font-normal text-fg-2">
      <span aria-hidden="true" className="flex items-center gap-0.5">
        {path.glyphs.map((glyph) => (
          <span key={glyph.step} className={cn('h-1.5 w-4 rounded-full', SEGMENT[glyph.state])} />
        ))}
      </span>
      <span className="tabular">
        {done} of {path.glyphs.length} steps done
        {path.quizScore !== null ? `, quiz ${Math.round(path.quizScore)}%` : ''}
        {percent !== null ? `, mastery ${percent}%` : ''}
      </span>
    </span>
  )
}

/** A step is done, or the quiz taken, but no mastery is earned yet: the topic header says "In progress" then, and so does the list. */
const started = (topic: ListTopic) => topic.path.glyphs.some((glyph) => glyph.state === 'done')

/**
 * A topic is one recommended move ("Next: Read") and one status ("Learning", and when its review is due). Completion and mastery
 * in numbers, and what the topic covers, are one tap away in the row's detail, so the list can be read down in a glance.
 */
function TopicRowItem({ courseId, topic }: { courseId: string; topic: ListTopic }) {
  const level = masteryLevel(topic.mastery)
  const percent = masteryPercent(topic.mastery)
  const { path } = topic
  const [open, setOpen] = React.useState(false)
  const detailId = React.useId()
  return (
    <li>
      <div className="flex items-center gap-1">
        <Link
          href={`/courses/${courseId}/topics/${topic.id}`}
          className="group flex min-h-14 min-w-0 flex-1 items-center gap-x-4 rounded-control px-2 py-2.5 transition-colors duration-120 hover:bg-surface-2"
        >
          <ProgressRing
            size={28}
            value={level === 'none' ? null : topic.mastery}
            tone={masteryTone(level) === 'warning' ? 'warning' : 'accent'}
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-body-strong text-fg">
              <span className="min-w-0 truncate">{topic.name}</span>
              {topic.examRelevant ? <Badge tone="accent" className="max-sm:hidden">On past exams</Badge> : null}
            </p>
            <p className="truncate text-small text-fg-2">{path.nextWords}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end text-right">
            <span className="text-small text-fg">{level === 'none' && started(topic) ? 'In progress' : masteryLabel(topic.mastery)}</span>
            {topic.timing ? (
              <span
                suppressHydrationWarning
                className={cn('text-caption font-normal', topic.timing.due ? 'text-warning-soft-fg' : 'text-fg-3')}
              >
                {topic.timing.text}
              </span>
            ) : null}
          </div>
        </Link>
        <IconButton
          label={open ? `Hide details: ${topic.name}` : `Show details: ${topic.name}`}
          icon={<CaretDown className={cn('transition-transform duration-180', open && 'rotate-180')} />}
          size="sm"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((current) => !current)}
        />
      </div>
      <div id={detailId} hidden={!open} className="flex flex-col gap-1.5 px-2 pb-3 pl-[52px]">
        {topic.examRelevant ? <Badge tone="accent" className="self-start sm:hidden">On past exams</Badge> : null}
        {topic.description ? <p className="max-w-[68ch] text-small text-fg-2">{topic.description}</p> : null}
        <PathStatus path={path} percent={percent} />
      </div>
    </li>
  )
}

type Group = UnitGroupOf<ListTopic, TopicsData['units'][number]>

/** One unit: its title, week, size and mastery, then its topics. Topics with no unit (a topic added by hand) are "Not in a unit": a list only groups when the course has units. */
function UnitGroup({ courseId, group }: { courseId: string; group: Group }) {
  const headingId = React.useId()
  const { unit, topics } = group
  const mastery = unitMastery(topics.map((topic) => topic.mastery))
  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-2">
        <h2 id={headingId} className="min-w-0 text-heading text-fg">
          {unit ? <MathText>{unit.title}</MathText> : 'Not in a unit'}
        </h2>
        {unit?.weekLabel ? <Badge>{unit.weekLabel}</Badge> : null}
        <span className="text-small tabular text-fg-3">{pluralize(topics.length, 'topic')}</span>
        {unit ? <MasteryIndicator mastery={mastery} showPercent emptyLabel={topics.some(started) ? 'In progress' : undefined} className="ml-auto text-small" /> : null}
      </div>
      {unit?.summary ? <p className="-mt-1 mb-2 max-w-[68ch] px-2 text-small text-fg-2">
          <MathText>{unit.summary}</MathText>
        </p> : null}
      <ul
        aria-label={unit ? `Topics in ${unit.title}` : 'Topics not in a unit'}
        className="divide-y divide-border border-y border-border"
      >
        {topics.map((topic) => (
          <TopicRowItem key={topic.id} courseId={courseId} topic={topic} />
        ))}
      </ul>
    </section>
  )
}

type Sort = 'order' | 'needs-work'

type TopicsListProps = {
  courseId: string
  topics: ListTopic[]
  /** In course order; empty for a flat course, which is one plain list. */
  units: TopicsData['units']
  summary: string
  generation: GenerationState
  /** When this page was rendered, in ms, so "Needs work" can tell what is due. */
  now: number
  /** "3 new topics to review" while found topics wait for the student, else null. */
  newTopics?: string | null
}

/** Confirmed topics: progress, the study path, mastery and review timing, with a sort. */
export function TopicsList({ courseId, topics, units, summary, generation, now, newTopics = null }: TopicsListProps) {
  const [sort, setSort] = React.useState<Sort>('order')
  const ordered = sort === 'order' ? topics : needsWorkOrder(topics, now)
  // "Needs work" is one list across units; course order keeps them together under their unit.
  const groups = React.useMemo(() => groupTopicsByUnit(topics, units), [topics, units])
  const grouped = sort === 'order' && units.length > 0
  const building = generation.activeJobs > 0 || generation.failures.length > 0

  return (
    <>
      <PageIntro
        title="Topics"
        description={summary}
        actions={
          <Button asChild variant="secondary" icon={<PencilSimple />}>
            <Link href={`/courses/${courseId}/topics?edit=1`}>Edit topics</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {newTopics ? (
          <InlineAlert
            tone="accent"
            title={newTopics}
            action={
              <Button asChild size="sm" variant="primary">
                <Link href={`/courses/${courseId}/topics?edit=1`}>Review new topics</Link>
              </Button>
            }
          >
            They join your plan once you confirm them.
          </InlineAlert>
        ) : null}
        {building ? <BuildingContent courseId={courseId} generation={generation} /> : null}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <StatusGuide parts={['topic', 'steps', 'quiz']} id="topics-status-guide" />
            <div className="flex items-center gap-3">
            <span id="sort-label" className="text-small text-fg-2">
              Sort by
            </span>
            <SegmentedControl
              aria-labelledby="sort-label"
              value={sort}
              onValueChange={setSort}
              options={[
                { value: 'order', label: 'Course order' },
                { value: 'needs-work', label: 'Needs work' },
              ]}
            />
            </div>
          </div>
          {grouped ? (
            <div className="flex flex-col gap-8">
              {groups.map((group) => (
                <UnitGroup key={group.unit?.id ?? 'loose'} courseId={courseId} group={group} />
              ))}
            </div>
          ) : (
            <ul aria-label="Topics" className="divide-y divide-border border-y border-border">
              {ordered.map((topic) => (
                <TopicRowItem key={topic.id} courseId={courseId} topic={topic} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}
