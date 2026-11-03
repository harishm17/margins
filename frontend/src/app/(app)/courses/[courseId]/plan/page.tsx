import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlanView } from '@/features/plan/plan-view'
import { PlanSetupGate } from '@/features/plan/plan-setup-gate'
import { QuickPass } from '@/features/plan/quick-pass'
import { quickPassTopicIds } from '@/lib/learning/short-session-server'
import { readyToStudy } from '@/lib/course-setup'
import { getPlanData } from '@/server/queries/plan'
import { getCourseShell } from '@/server/queries/courses'
import { conceptTopicsOf } from '@/server/queries/course'
import { topicActivities } from '@/server/queries/topic-activity'
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
  // Today's learn and quiz rows are worded by the topic's next activity, as on Home and the overview (spec §8.1).
  const today = data.plan.days.find((day) => day.isToday)
  const topicIds = (today?.items ?? []).flatMap((item) => (!item.done && item.topicId && (item.kind === 'learn' || item.kind === 'quiz') ? [item.topicId] : []))
  const activities = await topicActivities(user.id, courseId, topicIds, data.course.topics, data.course.setup.topics.listConfirmed)
  // Quick pass (spec 18.8): offered on each topic that did not fit when time is short, and undone from the same place.
  const quickIds = new Set(await quickPassTopicIds(user.id, courseId))
  const nameOf = new Map(data.course.topics.map((topic) => [topic.id, topic.name]))
  const quick = [...quickIds].flatMap((id) => (nameOf.has(id) ? [{ id, name: nameOf.get(id) as string }] : []))
  const unplaced = data.plan.short ? (data.plan.notScheduled?.topics ?? []) : []
  return (
    <PlanView
      courseId={courseId}
      plan={data.plan}
      unitTitles={unitTitles}
      conceptTopicIds={conceptTopicsOf(data.course.topics)}
      activities={activities}
      quickPass={unplaced.length > 0 || quick.length > 0 ? <QuickPass courseId={courseId} unplaced={unplaced} quick={quick} /> : null}
    />
  )
}
