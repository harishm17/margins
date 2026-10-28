'use client'

import * as React from 'react'
import Link from 'next/link'
import { Check, Exam, Lightbulb, Notebook, PencilSimple, PencilSimpleLine } from '@phosphor-icons/react/dist/ssr'
import { PageIntro } from '@/components/shell/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProgressRing } from '@/components/ui/progress-ring'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tooltip } from '@/components/ui/tooltip'
import { MathText } from '@/components/ui/math-text'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { pluralize } from '@/lib/format'
import { masteryLabel, masteryLevel, masteryPercent, masteryTone } from '@/lib/mastery'
import { groupTopicsByUnit, unitMastery, type UnitGroup as UnitGroupOf } from '@/lib/topics/units'
import { cn } from '@/lib/utils'
import type { GenerationState, TopicsData } from '@/server/queries/course'
import { BuildingContent } from './building-content'
import { needsWorkOrder, topicRowLabel, type GlyphState } from './summary'

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
  path: { notes: GlyphState; examples: GlyphState; practice: GlyphState; quiz: GlyphState; quizScore: number | null }
}

type GlyphProps = {
  label: string
  state: GlyphState
  icon: React.ReactNode
  score?: number | null
}

const STATE_WORDS: Record<GlyphState, string> = {
  done: 'done',
  ready: 'ready',
  missing: 'not written yet',
}

/** One of the four study path circles: filled with a check when done, ringed when it exists, dashed when missing. */
function Glyph({ label, state, icon, score }: GlyphProps) {
  const hasScore = score !== null && score !== undefined
  const words = hasScore ? `${label}: best ${Math.round(score)}%` : `${label}: ${STATE_WORDS[state]}`
  const base = 'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular [&>svg]:size-3'
  const look =
    state === 'done'
      ? 'bg-accent text-accent-fg'
      : state === 'ready'
        ? 'border-2 border-accent text-accent'
        : 'border border-dashed border-border-strong text-fg-3'
  return (
    <Tooltip content={words}>
      <span role="img" aria-label={words} className={cn(base, look, hasScore && 'px-1.5')}>
        {hasScore ? `${Math.round(score)}%` : state === 'done' ? <Check weight="bold" /> : icon}
      </span>
    </Tooltip>
  )
}

function TopicRowItem({ courseId, topic }: { courseId: string; topic: ListTopic }) {
  const level = masteryLevel(topic.mastery)
  const percent = masteryPercent(topic.mastery)
  const { path } = topic
  return (
    <li>
      <Link
        href={`/courses/${courseId}/topics/${topic.id}`}
        aria-label={topicRowLabel(topic)}
        className="group flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 rounded-control px-2 py-2.5 transition-colors duration-120 hover:bg-surface-2 sm:flex-nowrap"
      >
        <ProgressRing
          size={28}
          value={level === 'none' ? null : topic.mastery}
          tone={masteryTone(level) === 'warning' ? 'warning' : 'accent'}
          aria-label={percent === null ? 'Not started' : `${masteryLabel(topic.mastery)}, ${percent}%`}
        />
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex items-center gap-2 text-body-strong text-fg">
            <span className="min-w-0 truncate">{topic.name}</span>
            {topic.examRelevant ? <Badge tone="accent">On past exams</Badge> : null}
          </p>
          {topic.description ? <p className="truncate text-small text-fg-2">{topic.description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Study path">
          <Glyph label="Notes" state={path.notes} icon={<Notebook />} />
          <Glyph label="Worked examples" state={path.examples} icon={<Lightbulb />} />
          <Glyph label="Practice" state={path.practice} icon={<PencilSimpleLine />} />
          <span className="inline-flex w-10 justify-center">
            <Glyph label="Quiz" state={path.quiz} icon={<Exam />} score={path.quizScore} />
          </span>
        </div>
        <div className="flex w-full shrink-0 flex-col sm:w-40 sm:items-end">
          <span className="text-small text-fg">{masteryLabel(topic.mastery)}</span>
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
    </li>
  )
}

type Group = UnitGroupOf<ListTopic, TopicsData['units'][number]>

/** One unit: its title, week, size and mastery, then its topics. The topics with no unit get a plain "Topics" heading. */
function UnitGroup({ courseId, group }: { courseId: string; group: Group }) {
  const headingId = React.useId()
  const { unit, topics } = group
  const mastery = unitMastery(topics.map((topic) => topic.mastery))
  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-2">
        <h2 id={headingId} className="min-w-0 text-heading text-fg">
          {unit ? <MathText>{unit.title}</MathText> : 'Topics'}
        </h2>
        {unit?.weekLabel ? <Badge>{unit.weekLabel}</Badge> : null}
        <span className="text-small tabular text-fg-3">{pluralize(topics.length, 'topic')}</span>
        {unit ? <MasteryIndicator mastery={mastery} showPercent className="ml-auto text-small" /> : null}
      </div>
      {unit?.summary ? <p className="-mt-1 mb-2 max-w-[68ch] px-2 text-small text-fg-2">
          <MathText>{unit.summary}</MathText>
        </p> : null}
      <ul
        aria-label={unit ? `Topics in ${unit.title}` : 'Topics'}
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
}

/** Confirmed topics: progress, the study path, mastery and review timing, with a sort. */
export function TopicsList({ courseId, topics, units, summary, generation, now }: TopicsListProps) {
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
        {building ? <BuildingContent courseId={courseId} generation={generation} /> : null}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-end gap-3">
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
