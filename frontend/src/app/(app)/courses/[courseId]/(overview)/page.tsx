import { notFound } from 'next/navigation'
import { SetupGuide } from '@/features/course/setup-guide'
import { TodayView } from '@/features/course/today-view'
import { getCourseOverview } from '@/server/queries/course'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'
import { OverviewSkeleton } from '@/features/shell/page-skeletons'
import { getTimeZoneState } from '@/server/timezone'

export async function generateMetadata({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const course = await getCourseShell(user.id, (await params).courseId)
  // A course that does not exist (or is not the student's) shows the not-found page, so the tab says so.
  return { title: course?.name ?? 'Page not found' }
}

export default async function CourseOverviewPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const { timeZone, known } = await getTimeZoneState()
  if (!known) return <OverviewSkeleton />
  const overview = await getCourseOverview(user.id, courseId, timeZone)
  if (!overview) notFound()

  if (overview.mode === 'setup') {
    return <SetupGuide courseId={courseId} name={overview.course.name} setup={overview.setup} />
  }
  return <TodayView course={overview.course} today={overview.today} />
}
