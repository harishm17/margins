import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Exam } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { examDefaultsFromParams, onlyWithPages, preselectTopics } from '@/features/exams/exam-options'
import { topicsFromParam } from '@/lib/exams/form-defaults'
import { NewExamForm } from '@/features/exams/new-exam-form'
import { prisma } from '@/lib/db/prisma'
import { getCourseShell } from '@/server/queries/courses'
import { findActiveExamJob, getExamStyleState } from '@/server/queries/mock-exams'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'New mock exam' }

const serverClock = (): number => Date.now()

export default async function NewExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>
  searchParams: Promise<{ minutes?: string | string[]; questions?: string | string[]; topics?: string | string[] }>
}) {
  const user = await requireUser()
  const { courseId } = await params
  const query = await searchParams
  const initial = examDefaultsFromParams(query)
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()

  const topics = course.topics.filter((topic) => topic.confirmed)
  const [activeJob, examStyle, withPages] = await Promise.all([
    findActiveExamJob(user.id, courseId),
    getExamStyleState(user.id, courseId),
    // A topic with no pages linked to it has nothing to write questions from, and the exam leaves it out. Pages are linked when the
    // topic is found in the files, or the first time it is opened; so "none yet" is said here as a warning, not as a certainty.
    prisma.topic.findMany({
      where: { projectId: courseId, id: { in: topics.map((topic) => topic.id) }, OR: [{ sources: { some: {} } }, { topicChunkMappings: { some: {} } }] },
      select: { id: true },
    }),
  ])
  const linked = new Set(withPages.map((topic) => topic.id))

  return (
    <Page width="focus">
      <PageIntro title="New mock exam" description="Choose what to cover and how it should feel." />
      {topics.length === 0 ? (
        <EmptyState
          icon={<Exam />}
          title="Confirm your topics first"
          action={
            <Button asChild variant="primary">
              <Link href={`/courses/${courseId}/topics`}>Go to topics</Link>
            </Button>
          }
        >
          Mock exams are built from your topics. Check and confirm them, then come back.
        </EmptyState>
      ) : (
        <NewExamForm
          courseId={courseId}
          topics={topics.map((topic) => ({ id: topic.id, name: topic.name, mastery: topic.mastery, hasPages: linked.has(topic.id) }))}
          preselected={onlyWithPages(
            // A link from the plan names its topics; ids that are not confirmed topics of this course are ignored.
            // Either way a topic with no pages is left unticked: the exam would leave it out, so it is the student's choice to add it.
            topicsFromParam(query.topics, topics.map((topic) => topic.id)) ??
              preselectTopics(
                topics.map((topic) => ({ id: topic.id, mastery: topic.mastery, dueAt: topic.dueAt })),
                serverClock()
              ),
            linked
          )}
          activeJob={activeJob}
          examStyle={examStyle}
          initial={initial}
        />
      )}
    </Page>
  )
}
