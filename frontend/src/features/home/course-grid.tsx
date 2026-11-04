import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import type { CourseListItem } from '@/server/queries/courses'
import { newTopicsLabel } from '@/lib/course-setup'
import { reviewTiming } from '@/features/course/summary'
import { activeStatusLine } from './status-line'

/**
 * One course: its name, one line of where it stands ("1 of 5 topics strong", or the setup step it is on) and when the next
 * review falls due. How the topics are spread across the levels is the course overview's job, not a strip on every card.
 */
export function CourseCard({ course, now, timeZone = 'UTC' }: { course: CourseListItem; now: number; timeZone?: string }) {
  const status = course.setup.mode === 'setup' ? course.setup.label : activeStatusLine(course.levels)
  const newTopics = newTopicsLabel(course.setup.topics)
  const timing = course.setup.mode === 'active' ? reviewTiming(course.nextDueAt, now, timeZone) : null
  return (
    <Card interactive asChild className="flex h-full flex-col gap-2">
      <Link href={`/courses/${course.id}`}>
        <h3 className="truncate text-subheading text-fg">{course.name}</h3>
        <p className="text-small text-fg-2">{status}</p>
        {newTopics ? <p className="text-small text-accent-soft-fg">{newTopics}</p> : null}
        {timing ? <p className={timing.due ? 'text-small text-warning-soft-fg' : 'text-small text-fg-2'}>{timing.text}</p> : null}
        <p className="mt-auto pt-1 text-caption font-normal text-fg-3">
          Updated <RelativeTime date={course.updatedAt} />
        </p>
      </Link>
    </Card>
  )
}

/**
 * Courses being studied come first, most recently touched first (the list arrives in that order); a course still
 * in setup has nothing to study yet, so it goes after them, in the same order.
 */
export function orderCourses<T extends { setup: { mode: string } }>(courses: readonly T[]): T[] {
  return [...courses.filter((course) => course.setup.mode !== 'setup'), ...courses.filter((course) => course.setup.mode === 'setup')]
}

export function CourseGrid({ courses, now, timeZone }: { courses: CourseListItem[]; now: number; timeZone?: string }) {
  return (
    <section aria-labelledby="courses-heading">
      <h2 id="courses-heading" className="text-heading text-fg">
        Courses
      </h2>
      <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {orderCourses(courses).map((course) => (
          <li key={course.id}>
            <CourseCard course={course} now={now} timeZone={timeZone} />
          </li>
        ))}
      </ul>
    </section>
  )
}
