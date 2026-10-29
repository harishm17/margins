import { notFound } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { practiceKeys } from '@/features/topic/practice-keys'
import { PracticeProgressSync } from '@/features/topic/practice-progress'
import { StudyTabs } from '@/features/topic/study-tabs'
import { TopicActions, TopicHeader } from '@/features/topic/topic-header'
import { noticeForCode, type GenerationNotice } from '@/features/topic/notice'
import { TopicProvider } from '@/features/topic/topic-provider'
import { CONTENT_KINDS, type ContentKind } from '@/features/topic/types'
import { getTopicPage } from '@/server/queries/topic'
import { requireUser } from '@/server/session'

/**
 * The topic's chrome: header, study path and the generation state. It stays mounted while the
 * student moves between views (the views are search params of the page below), so a job that
 * is running keeps being followed and the tabs do not flicker.
 */
export default async function TopicLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ courseId: string; topicId: string }>
}) {
  const user = await requireUser()
  const { courseId, topicId } = await params
  const data = await getTopicPage(user.id, courseId, topicId)
  if (!data) notFound()
  const { topic, content } = data

  const initialFailures: Partial<Record<ContentKind, GenerationNotice>> = {}
  for (const kind of CONTENT_KINDS) {
    const failure = data.failures[kind]
    if (failure) {
      initialFailures[kind] = { ...noticeForCode(failure.errorCode), message: failure.message }
    }
  }

  return (
    <TopicProvider
      topicId={topicId}
      courseId={courseId}
      contentVersion={data.contentVersion}
      initialFailures={initialFailures}
      notesPresent={data.present.notes}
      next={data.next}
    >
      <TopicActions courseId={courseId} topicId={topicId} name={topic.name} />
      <PracticeProgressSync topicId={topicId} server={data.practiceProgress} />
      <Page className="pt-6">
        <TopicHeader
          courseId={courseId}
          name={topic.name}
          description={topic.description}
          mastery={topic.mastery}
          earnedMastery={topic.earnedMastery}
          dueAt={topic.dueAt}
          daysUntilDue={topic.daysUntilDue}
          bestQuiz={topic.progress.quizScore}
          previous={data.previous}
          next={data.next}
          structure={topic.structure}
        />
        <StudyTabs
          courseId={courseId}
          topicId={topicId}
          present={data.present}
          progress={topic.progress}
          practiceKeys={practiceKeys(content.practice?.items)}
          previousId={data.previous?.id ?? null}
          nextId={data.next?.id ?? null}
        />
        <div className="pt-8">{children}</div>
      </Page>
    </TopicProvider>
  )
}
