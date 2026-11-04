import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { practiceKeys } from '@/features/topic/practice-keys'
import { bareTopicRedirect, viewInPath } from '@/features/topic/activity-copy'
import { OnboardingCard } from '@/features/topic/onboarding-card'
import { PracticeProgressSync } from '@/features/topic/practice-progress'
import { StudyTabs } from '@/features/topic/study-tabs'
import { TopicActions, TopicHeader } from '@/features/topic/topic-header'
import { noticeForCode, type GenerationNotice } from '@/features/topic/notice'
import { TopicProvider } from '@/features/topic/topic-provider'
import { CONTENT_KINDS, type ContentKind } from '@/features/topic/types'
import { nextReviewLabel } from '@/lib/learning/consequence'
import { getTopicPage } from '@/server/queries/topic'
import { getTimeZone } from '@/server/timezone'
import { requireUser } from '@/server/session'

/**
 * The topic's chrome: header, topic path and the generation state. It stays mounted while the
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
  // A new topic is reviewed in the editor first, so it cannot gain content or progress meanwhile.
  if (data.awaitingReview) redirect(`/courses/${courseId}/topics?edit=1`)
  // A bare topic address is sent on to the topic's next activity here, before anything is sent to the browser: the page does the
  // same, but by then this layout's first HTML (with the one-time card in it) is on its way, and the card would count as seen.
  // Only for a page load: a move from another page inside the app is a request for the data, which the page answers.
  const requestHeaders = await headers()
  const path = requestHeaders.get('x-pathname')
  if (path !== null && requestHeaders.get('sec-fetch-mode') === 'navigate') {
    const bare = bareTopicRedirect(`/courses/${courseId}/topics/${topicId}`, viewInPath(path), { kind: data.nextActivity.kind, href: data.nextActivity.href }, data.preparingEntry)
    if (bare) redirect(bare)
  }
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
      <Page width="wide" className="pt-3 sm:pt-6">
        <TopicHeader
          courseId={courseId}
          topicId={topicId}
          name={topic.name}
          description={topic.description}
          mastery={topic.mastery}
          started={data.begun || topic.progress.notes || topic.progress.examples || topic.progress.quizScore !== null}
          earnedMastery={topic.earnedMastery}
          dueAt={topic.dueAt}
          daysUntilDue={topic.daysUntilDue}
          nextReviewText={topic.dueAt && topic.daysUntilDue !== null && topic.daysUntilDue > 0 ? nextReviewLabel(topic.dueAt, new Date(), await getTimeZone()) : null}
          bestQuiz={topic.progress.quizScore}
          previous={data.previous}
          next={data.next}
          structure={topic.structure}
          concepts={data.concepts}
        />
        {data.showEffortIntro ? <OnboardingCard userId={user.id} /> : null}
        <StudyTabs
          courseId={courseId}
          topicId={topicId}
          present={data.present}
          progress={topic.progress}
          practiceKeys={practiceKeys(content.practice?.items)}
          previousId={data.previous?.id ?? null}
          nextId={data.next?.id ?? null}
          pathDone={data.pathDone}
          recallProgress={data.recallProgress}
          steps={data.pathSteps}
          nextActivity={data.nextActivity}
          preparingEntry={data.preparingEntry}
        />
        <div data-tab-panel="" className="pt-5 sm:pt-8">
          {children}
        </div>
      </Page>
    </TopicProvider>
  )
}
