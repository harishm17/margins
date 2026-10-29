import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { courseSummary, reviewTiming, studyPath } from '@/features/course/summary'
import { TopicEditor } from '@/features/course/topic-editor'
import { TopicsList } from '@/features/course/topics-list'
import { newTopicsLabel } from '@/lib/course-setup'
import { countMasteryLevels, masteryLevel } from '@/lib/mastery'
import { getTopicsData } from '@/server/queries/course'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'
import { getTimeZone } from '@/server/timezone'

export const metadata: Metadata = { title: 'Topics' }

export default async function TopicsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>
  searchParams: Promise<{ edit?: string }>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const { edit } = await searchParams
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()
  // The editor is a place in the URL, not something worked out from the topics: until the list is
  // confirmed the page sends the student there, so the refresh after adding or merging a topic can
  // never swap the editor for the list mid-edit. Confirm (not adding topics) finishes the list.
  if (edit !== '1' && !course.setup.topics.listConfirmed) redirect(`/courses/${courseId}/topics?edit=1`)

  const data = await getTopicsData(user.id, courseId)
  if (!data) notFound()

  if (edit === '1') {
    return (
      <Page>
        <TopicEditor
          courseId={courseId}
          topics={data.topics.map((topic) => ({
            id: topic.id,
            name: topic.name,
            description: topic.description,
            keywords: topic.keywords,
            orderIndex: topic.orderIndex,
            confirmed: topic.confirmed,
            unitId: topic.unitId,
            sources: topic.sources,
          }))}
          units={data.units}
          extractJob={data.extractJob}
          extractFailure={data.extractFailure}
          filesReady={data.materialsReady}
          filesProcessing={data.materialsProcessing}
          topicList={data.setup.topics}
        />
      </Page>
    )
  }

  // eslint-disable-next-line react-hooks/purity -- a server component: one timestamp per request
  const now = Date.now()
  // New topics found after the list was confirmed are reviewed in the editor, not studied from this list.
  const listed = data.topics.filter((topic) => topic.confirmed)
  const counts = countMasteryLevels(listed.map((topic) => masteryLevel(topic.mastery)))
  const timeZone = await getTimeZone()
  const due = listed.filter((topic) => reviewTiming(topic.dueAt, now, timeZone)?.due).length

  return (
    <Page>
      <TopicsList
        courseId={courseId}
        summary={courseSummary(listed.length, counts, due)}
        generation={data.generation}
        now={now}
        units={data.units}
        newTopics={newTopicsLabel(data.setup.topics)}
        topics={listed.map((topic) => ({
          id: topic.id,
          name: topic.name,
          description: topic.description,
          orderIndex: topic.orderIndex,
          unitId: topic.unitId,
          examRelevant: topic.examRelevant,
          mastery: topic.mastery,
          dueAt: topic.dueAt,
          timing: reviewTiming(topic.dueAt, now, timeZone),
          path: studyPath({ content: topic.content, progress: topic.progress, practiceDone: topic.practiceDone }),
        }))}
      />
    </Page>
  )
}
