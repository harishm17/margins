import { notFound, redirect } from 'next/navigation'
import { defaultView } from '@/features/topic/default-view'
import { ExamplesView } from '@/features/topic/examples-view'
import { ContentGate } from '@/features/topic/generation-ui'
import { NotesView } from '@/features/topic/notes-view'
import { PracticeView } from '@/features/topic/practice-view'
import { QuizView } from '@/features/topic/quiz-view'
import { isViewId } from '@/features/topic/types'
import { VoiceView } from '@/features/topic/voice-view'
import { getTopicPage } from '@/server/queries/topic'
import { requireUser } from '@/server/session'

type Params = Promise<{ courseId: string; topicId: string }>
type SearchParams = Promise<{ view?: string | string[]; set?: string | string[]; start?: string | string[] }>

export async function generateMetadata({ params }: { params: Params }) {
  const user = await requireUser()
  const { courseId, topicId } = await params
  const data = await getTopicPage(user.id, courseId, topicId)
  return { title: data?.topic.name ?? 'Topic' }
}

/**
 * One view of the topic. Without a valid ?view= the page redirects to the first unfinished view
 * (or the notes), so the address always names what is on screen and finishing a view never
 * moves the student somewhere else on the next refresh.
 */
export default async function TopicPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireUser()
  const { courseId, topicId } = await params
  const { view: requested, set: requestedSet, start } = await searchParams
  const data = await getTopicPage(user.id, courseId, topicId)
  if (!data) notFound()

  const wanted = Array.isArray(requested) ? requested[0] : requested
  const base = `/courses/${courseId}/topics/${topicId}`
  if (!isViewId(wanted)) redirect(`${base}?view=${defaultView(data.topic.progress)}`)

  const { content, topic } = data

  switch (wanted) {
    case 'notes':
      return (
        <ContentGate kind="notes" topicName={topic.name} present={!!content.notes}>
          {content.notes ? (
            <NotesView
              topicId={topicId}
              notes={content.notes}
              completed={topic.progress.notes}
              nextHref={`${base}?view=examples`}
            />
          ) : null}
        </ContentGate>
      )
    case 'examples':
      return (
        <ContentGate kind="examples" topicName={topic.name} present={!!content.examples}>
          {content.examples ? (
            <ExamplesView
              topicId={topicId}
              examples={content.examples}
              completed={topic.progress.examples}
              nextHref={`${base}?view=practice`}
            />
          ) : null}
        </ContentGate>
      )
    case 'practice':
      return (
        <ContentGate kind="practice" topicName={topic.name} present={!!content.practice}>
          {content.practice ? <PracticeView topicId={topicId} practice={content.practice} /> : null}
        </ContentGate>
      )
    case 'quiz':
      return (
        <ContentGate kind="quiz" topicName={topic.name} present={!!content.quiz}>
          {content.quiz ? (
            <QuizView
              key={content.quiz.sets[0].id}
              courseId={courseId}
              topicId={topicId}
              review={data.review}
              initialSetId={Array.isArray(requestedSet) ? requestedSet[0] : requestedSet}
              autoStart={(Array.isArray(start) ? start[0] : start) === '1'}
              sets={content.quiz.sets}
              attempts={data.attempts}
              voiceHref={`${base}?view=voice`}
            />
          ) : null}
        </ContentGate>
      )
    default:
      return <VoiceView courseId={courseId} topic={{ id: topicId, name: topic.name, keywords: topic.keywords }} />
  }
}
