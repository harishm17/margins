import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ReviewFocus } from '@/features/review/review-focus'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Review session' }

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined

/**
 * A review session or concept drill on a screen of its own (spec §7.4): ?topic= filters today's review to
 * a topic, ?concept= drills one concept (the map and "what comes next" link here), ?session= goes on with
 * one already started. With none of them it is today's review.
 */
export default async function ReviewSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const query = await searchParams
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()
  return (
    <ReviewFocus
      courseId={courseId}
      courseName={course.name}
      topicId={first(query.topic)}
      conceptId={first(query.concept)}
      sessionId={first(query.session)}
    />
  )
}
