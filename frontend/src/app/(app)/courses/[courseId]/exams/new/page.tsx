import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Exam } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { preselectTopics } from '@/features/exams/exam-options'
import { NewExamForm } from '@/features/exams/new-exam-form'
import { getCourseShell } from '@/server/queries/courses'
import { findActiveExamJob, getExamStyleState } from '@/server/queries/mock-exams'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'New mock exam' }

const serverClock = (): number => Date.now()

export default async function NewExamPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()

  const topics = course.topics.filter((topic) => topic.confirmed)
  const [activeJob, examStyle] = await Promise.all([
    findActiveExamJob(user.id, courseId),
    getExamStyleState(user.id, courseId),
  ])

  return (
    <Page width="medium">
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
          topics={topics.map((topic) => ({ id: topic.id, name: topic.name, mastery: topic.mastery }))}
          preselected={preselectTopics(
            topics.map((topic) => ({ id: topic.id, mastery: topic.mastery, dueAt: topic.dueAt })),
            serverClock()
          )}
          activeJob={activeJob}
          examStyle={examStyle}
        />
      )}
    </Page>
  )
}
