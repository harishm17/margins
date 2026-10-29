import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { countMasteryLevels, MASTERY_LABELS, type MasteryLevel } from '@/lib/mastery'
import { cn } from '@/lib/utils'
import type { CourseListItem } from '@/server/queries/courses'
import { activeStatusLine } from './status-line'

const MAX_SQUARES = 40

const SQUARE: Record<MasteryLevel, string> = {
  none: 'bg-surface-3',
  learning: 'bg-learning',
  getting: 'bg-accent/50',
  strong: 'bg-accent',
}

/** One 8px square per topic, coloured by mastery. After 40, "+N". */
export function MasteryStrip({ levels }: { levels: MasteryLevel[] }) {
  if (levels.length === 0) return <div className="h-2" />
  const shown = levels.slice(0, MAX_SQUARES)
  const rest = levels.length - shown.length
  const counts = countMasteryLevels(levels)
  const summary = (['strong', 'getting', 'learning', 'none'] as const)
    .filter((level) => counts[level] > 0)
    .map((level) => `${counts[level]} ${MASTERY_LABELS[level].toLowerCase()}`)
    .join(', ')

  return (
    <div role="img" aria-label={`Topic mastery: ${summary}`} className="flex flex-wrap items-center gap-[3px]">
      {shown.map((level, index) => (
        <span key={index} className={cn('size-2 rounded-[2px]', SQUARE[level])} />
      ))}
      {rest > 0 ? <span className="ml-1 text-caption text-fg-3 tabular">+{rest}</span> : null}
    </div>
  )
}

export function CourseCard({ course }: { course: CourseListItem }) {
  const status = course.setup.mode === 'setup' ? course.setup.label : activeStatusLine(course.levels)
  return (
    <Card interactive asChild className="flex h-full flex-col gap-3">
      <Link href={`/courses/${course.id}`}>
        <h3 className="truncate text-subheading text-fg">{course.name}</h3>
        <p className="text-small text-fg-2">{status}</p>
        <MasteryStrip levels={course.levels} />
        <p className="mt-auto pt-1 text-caption font-normal text-fg-3">
          Updated <RelativeTime date={course.updatedAt} />
        </p>
      </Link>
    </Card>
  )
}

const LEGEND_ORDER = ['strong', 'getting', 'learning', 'none'] as const

/**
 * What the squares mean, once above the grid rather than on every card. Visible words, so it works
 * with touch and a keyboard (a tooltip on a square inside a card link would not). Shown only when a
 * card has squares.
 */
export function MasteryLegend({ className }: { className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-caption font-normal text-fg-3', className)}>
      <span>One square per topic:</span>
      {LEGEND_ORDER.map((level) => (
        <span key={level} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('size-2 rounded-[2px]', SQUARE[level])} />
          {MASTERY_LABELS[level]}
        </span>
      ))}
    </p>
  )
}

export function CourseGrid({ courses }: { courses: CourseListItem[] }) {
  const anySquares = courses.some((course) => course.levels.length > 0)
  return (
    <section aria-labelledby="courses-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="courses-heading" className="text-heading text-fg">
          Courses
        </h2>
        {anySquares ? <MasteryLegend /> : null}
      </div>
      <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((course) => (
          <li key={course.id}>
            <CourseCard course={course} />
          </li>
        ))}
      </ul>
    </section>
  )
}
