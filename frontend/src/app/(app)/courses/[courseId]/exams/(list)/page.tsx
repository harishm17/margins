import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Plus } from '@phosphor-icons/react/dist/ssr'
import { Page, PageIntro } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { ExamList, NoExams } from '@/features/exams/exam-list'
import { getCourseShell } from '@/server/queries/courses'
import { listExams } from '@/server/queries/mock-exams'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Mock exams' }

export default async function ExamsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()

  const exams = await listExams(user.id, courseId)
  const canCreate = course.topics.some((topic) => topic.confirmed)
  const hasExams = exams.length > 0

  // One primary action per state: with no exams the empty state holds "New mock exam" (or the way to
  // topics, with its reason), so the header has no second copy of it.
  return (
    <Page>
      <PageIntro
        title="Mock exams"
        description="Timed practice exams built from your topics."
        actions={
          !hasExams ? null : canCreate ? (
            <Button asChild variant="primary" icon={<Plus />}>
              <Link href={`/courses/${courseId}/exams/new`}>New mock exam</Link>
            </Button>
          ) : (
            <Button variant="primary" icon={<Plus />} disabled aria-describedby="exams-disabled-reason">
              New mock exam
            </Button>
          )
        }
      />
      {hasExams ? <ExamList courseId={courseId} exams={exams} /> : <NoExams courseId={courseId} canCreate={canCreate} />}
      {hasExams && !canCreate ? (
        <p id="exams-disabled-reason" className="mt-4 text-small text-fg-2">
          Confirm your topics to build new mock exams.
        </p>
      ) : null}
    </Page>
  )
}
