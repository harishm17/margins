import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AskPageLazy } from '@/features/ask/ask-page-lazy'
import { MAX_QUESTION_CHARS } from '@/lib/ask/explain'
import { countSearchableMaterials, getAskThread, listAskThreads, serverNow } from '@/server/queries/ask'
import { getCourseShell } from '@/server/queries/courses'
import { requireUser } from '@/server/session'
import { prisma } from '@/lib/db/prisma'

export const metadata: Metadata = { title: 'Ask' }

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export default async function AskRoute({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>
  searchParams: Promise<{ thread?: string | string[]; topic?: string | string[]; concept?: string | string[]; q?: string | string[] }>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const query = await searchParams
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()

  const threadId = first(query.thread)
  const topicParam = first(query.topic)
  // "Explain this mistake" arrives with the question already written; it is only a draft, nothing is sent.
  const draft = (first(query.q) ?? '').slice(0, MAX_QUESTION_CHARS)
  // "Ask about this" on the knowledge map: a new conversation about one of the course's concepts, in that concept's topic.
  const conceptParam = threadId ? undefined : first(query.concept)
  const concept = conceptParam
    ? await prisma.concept.findFirst({
        where: { id: conceptParam, projectId: courseId, status: 'active', project: { userId: user.id } },
        select: { id: true, name: true, topicId: true },
      })
    : null
  const topics = course.topics.filter((topic) => topic.confirmed).map((topic) => ({ id: topic.id, name: topic.name }))

  const wantedTopic = topicParam ?? concept?.topicId
  const chosenTopic = wantedTopic && topics.some((topic) => topic.id === wantedTopic) ? wantedTopic : null

  const [threads, initialThread, materialCount] = await Promise.all([
    listAskThreads(user.id, courseId),
    threadId ? getAskThread(user.id, courseId, threadId) : Promise.resolve(null),
    countSearchableMaterials(user.id, courseId),
  ])

  return (
    <AskPageLazy
      courseId={courseId}
      threads={threads}
      initialThread={initialThread}
      topics={topics}
      initialTopicId={chosenTopic}
      initialConcept={concept ? { id: concept.id, name: concept.name } : null}
      hasMaterials={materialCount > 0}
      initialDraft={threadId ? '' : draft}
      now={serverNow()}
    />
  )
}
