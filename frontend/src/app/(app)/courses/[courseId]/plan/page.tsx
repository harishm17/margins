import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlanView } from '@/features/plan/plan-view'
import { PlanSetupGate } from '@/features/plan/plan-setup-gate'
import { readyToStudy } from '@/lib/course-setup'
import { getPlanData } from '@/server/queries/plan'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'
import { PlanSkeleton } from '@/features/shell/page-skeletons'
import { getTimeZoneState } from '@/server/timezone'

export const metadata: Metadata = { title: 'Plan' }

export default async function PlanPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  // The plan needs steps 1 and 2 done (files or content, and a confirmed topic list): before that the page says what is next.
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()
  if (!readyToStudy(course.setup) && course.setup.mode === 'setup') {
    return <PlanSetupGate courseId={courseId} setup={course.setup} />
  }
  const { timeZone, known } = await getTimeZoneState()
  // The browser's first request: its time zone is not known, so wait for it rather than draw the wrong days.
  if (!known) return <PlanSkeleton />
  const data = await getPlanData(user.id, courseId, timeZone)
  if (!data) notFound()
  const unitTitles = Object.fromEntries(data.course.units.map((unit) => [unit.id, unit.title]))
  return <PlanView courseId={courseId} plan={data.plan} unitTitles={unitTitles} />
}
